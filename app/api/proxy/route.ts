import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /\.local$/i,
];

const BLOCK_HEADERS = [
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  // Prevent cross-origin isolation/frame blocking from upstream
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "document-policy",
  "origin-agent-cluster",
  // optional: some sites misuse this and it can cascade issues when proxied
  "permissions-policy",
];

// --- Minimal cookie jar utilities (per upstream host) ---
function jarNameFor(host: string) {
  // avoid dots in cookie name
  return `__pxjar_${host.replace(/[^a-z0-9]/gi, "_")}`;
}
function readJar(req: NextRequest, host: string): Record<string, string> {
  try {
    const v = req.cookies.get(jarNameFor(host))?.value;
    if (!v) return {};
    const obj = JSON.parse(v);
    if (obj && typeof obj === "object") return obj as Record<string, string>;
    return {};
  } catch {
    return {};
  }
}
function buildCookieHeader(jar: Record<string, string>): string | undefined {
  const pairs = Object.entries(jar).filter(([, v]) => typeof v === "string" && v.length > 0).map(([k, v]) => `${k}=${v}`);
  return pairs.length ? pairs.join("; ") : undefined;
}
function mergeSetCookie(jar: Record<string, string>, setCookieHeader: string | null): Record<string, string> {
  if (!setCookieHeader) return jar;
  try {
    // handle multiple set-cookie concatenated by comma if present
    const parts = setCookieHeader.split(/,(?=[^;]+=)/g);
    for (const part of parts) {
      const seg = part.split(";")[0]?.trim() ?? "";
      const eq = seg.indexOf("=");
      if (eq <= 0) continue;
      const name = seg.slice(0, eq).trim();
      const value = seg.slice(eq + 1).trim();
      if (!name) continue;
      // simplistic delete detection
      const lower = part.toLowerCase();
      const isDelete = lower.includes("max-age=0") || lower.includes("expires=") && /expires=\w+,\s\d{2}\s\w+\s\d{4}\s\d{2}:\d{2}:\d{2}\sgmt/i.test(part) && new Date(part.match(/expires=([^;]+)/i)?.[1] || 0) < new Date();
      if (isDelete) delete jar[name];
      else jar[name] = value;
    }
  } catch { /* ignore */ }
  return jar;
}

// Parse Set-Cookie header into discrete cookies with optional Domain attribute
function parseSetCookies(setCookieHeader: string | null): Array<{ name: string; value: string; domain?: string; delete?: boolean }> {
  const out: Array<{ name: string; value: string; domain?: string; delete?: boolean }> = [];
  if (!setCookieHeader) return out;
  try {
    const parts = setCookieHeader.split(/,(?=[^;]+=)/g);
    for (const raw of parts) {
      const first = raw.split(";")[0]?.trim() ?? "";
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      let domain: string | undefined;
      const attrs = raw.split(";").slice(1);
      for (const a of attrs) {
        const [k, v] = a.split("=");
        if (k && /domain/i.test(k.trim())) {
          const d = (v || "").trim();
          if (d) domain = d.replace(/^\./, "").toLowerCase();
        }
      }
      const lower = raw.toLowerCase();
      const isDelete = lower.includes("max-age=0") || (lower.includes("expires=") && /expires=\w+,\s\d{2}\s\w+\s\d{4}\s\d{2}:\d{2}:\d{2}\sgmt/i.test(raw) && new Date(raw.match(/expires=([^;]+)/i)?.[1] || 0) < new Date());
      out.push({ name, value, domain, delete: isDelete });
    }
  } catch { /* ignore */ }
  return out;
}

function baseDomainOf(host: string): string | undefined {
  try {
    const parts = host.toLowerCase().split(".");
    if (parts.length >= 2) return parts.slice(-2).join(".");
  } catch {}
  return undefined;
}

function mergeCookieIntoJar(jar: Record<string, string>, ck: { name: string; value: string; delete?: boolean }): Record<string, string> {
  if (!ck.name) return jar;
  if (ck.delete) { delete jar[ck.name]; return jar; }
  jar[ck.name] = ck.value;
  return jar;
}

function buildCookieHeaderForHost(host: string, req: NextRequest, updates: Map<string, Record<string, string>>): string | undefined {
  const acc: Record<string, string> = {};
  const domains = new Set<string>();
  domains.add(host);
  const bd = baseDomainOf(host);
  if (bd) domains.add(bd);
  for (const d of domains) {
    const stored = readJar(req, d);
    for (const [k, v] of Object.entries(stored)) acc[k] = v;
    const up = updates.get(d) || {};
    for (const [k, v] of Object.entries(up)) acc[k] = v;
  }
  return buildCookieHeader(acc);
}

function absolutize(url: string, base: URL): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function isPrivateHost(hostname: string) {
  return PRIVATE_HOSTS.some((re) => re.test(hostname));
}

function isAlreadyProxied(href: string, proxyOrigin: string) {
  try {
    const u = new URL(href, proxyOrigin);
    return u.origin === proxyOrigin && u.pathname.startsWith("/api/proxy");
  } catch {
    return false;
  }
}

function rewriteCssUrls(css: string, proxyOrigin: string, base: URL) {
  return css.replace(/url\((['"]?)([^'")]+)\1\)/g, (_m, q, u) => {
    if (/^(data:|blob:|about:|javascript:)/i.test(u)) return `url(${q}${u}${q})`;
    // Skip about:blank variants even if expressed as protocol-relative
    try {
      const absTest = new URL(u, base);
      if (absTest.hostname.toLowerCase() === "about" && /^\/+blank$/i.test(absTest.pathname)) {
        return `url(${q}${u}${q})`;
      }
    } catch {}
    const abs = absolutize(u, base);
    // Avoid double-proxy
    if (isAlreadyProxied(abs, proxyOrigin)) return `url(${q}${abs}${q})`;
    return `url(${q}${proxyOrigin}/api/proxy?url=${encodeURIComponent(abs)}&asset=1${q})`;
  });
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function guessExt(pathname: string) {
  const m = pathname.match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  return m ? m[1].toLowerCase() : "";
}
function isLikelyImageExt(ext: string) {
  return /^(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i.test(ext);
}
function isLikelyAssetByExt(ext: string) {
  return /^(js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|bmp|webm|mp4|mp3|wav|ogg|woff2?|ttf|otf|map)$/i.test(ext);
}

function stripEncodingHeaders(h: Headers) {
  h.delete("content-encoding");
  h.delete("content-length");
  h.delete("transfer-encoding");
  h.delete("connection");
}

async function handleProxy(req: NextRequest, method: "GET" | "POST") {
  const proxyOrigin = req.nextUrl.origin;

  // ----- 1) Read and sanitize incoming ?url= -----
  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!rawUrl) return NextResponse.json({ error: "Missing url" }, { status: 400 });
  // Unwrap if someone fed our proxy its own URL to avoid recursion:
  // e.g. /api/proxy?url=https://your.app/api/proxy?url=https://remote
  let effectiveUrl = rawUrl;
  try {
    // Limit to a few unwraps to avoid malicious nesting
    for (let i = 0; i < 3; i++) {
      const candidate = new URL(effectiveUrl, proxyOrigin);
      if (candidate.origin === proxyOrigin && candidate.pathname.startsWith("/api/proxy")) {
        const inner = candidate.searchParams.get("url");
        if (!inner) break;
        effectiveUrl = inner;
      } else {
        break;
      }
    }
  } catch {
    // continue with original rawUrl if URL parsing fails here
  }

  let target: URL;
  try {
    target = new URL(effectiveUrl);
    if (!/^https?:$/.test(target.protocol)) throw new Error("Only http(s) allowed");
    if (isPrivateHost(target.hostname)) throw new Error("Blocked host");
   } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Invalid url: ${msg}` }, { status: 400 });
  }


  // Detect asset by &asset=1 or file extension
  const isAssetParam = req.nextUrl.searchParams.has("asset");
  const ext = guessExt(target.pathname);
  const isAssetByExt = isLikelyAssetByExt(ext);
  const isImage = isLikelyImageExt(ext);
  const isAssetReq = isAssetParam || isAssetByExt;

  // ----- 2) Fetch upstream with realistic headers -----
  let upstream: Response;
  // Track jars updated across redirects for all hosts involved
  const jarsUpdated = new Map<string, Record<string, string>>();
  // Track debug hops (URL, status, redirect location, cookies observed)
  const debugHops: Array<{ url: string; status: number; location?: string | null; setCookies?: Array<{ name: string; domain?: string }> }> = [];
  try {
    const ua =
      req.headers.get("user-agent") ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    const acceptLang = req.headers.get("accept-language") ?? "en-US,en;q=0.9";

    // Stricter Accept for SVG/images to satisfy some CDNs
    const accept = req.headers.get("accept") ??
      (isImage
        ? "image/svg+xml,image/avif,image/webp,image/*;q=0.8,*/*;q=0.5"
        : isAssetReq
        ? "*/*"
        : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");

    // Conservative headers: avoid browser-only sec-fetch-* which can confuse some origins
    const hdrs: Record<string, string> = {
      accept,
      "user-agent": ua,
      "accept-language": acceptLang,
      // Avoid compression to simplify downstream handling
      "accept-encoding": "identity",
    };
    // Pass through important Next.js Server Actions / RSC headers so server actions work
    try {
      const passPatterns: RegExp[] = [
        /^next-/i,            // Next-Action, Next-URL, Next-Router-State-Tree, etc.
        /^rsc$/i,             // RSC streaming indicator
        /^x-nextjs-/i,        // x-nextjs-* internals
        /^x-action-/i,        // x-action-* fallbacks
        /^x-middleware-/i,    // Next middleware hints
      ];
      const blocked = new Set<string>([
        "host", "connection", "content-length", "transfer-encoding", "accept-encoding", "cookie",
      ]);
      for (const [k, v] of req.headers.entries()) {
        const lk = k.toLowerCase();
        if (blocked.has(lk)) continue;
        if (passPatterns.some((re) => re.test(lk))) {
          // Do not overwrite explicitly set values like accept/content-type
          if (lk in hdrs) continue;
          hdrs[lk] = v;
        }
      }
    } catch {}
    // If this looks like an RSC/server-actions GET, provide an upstream-like Referer to appease middleware
    try {
      if (method === "GET") {
        let hasRscish = false;
        for (const k of req.headers.keys()) {
          const lk = k.toLowerCase();
          if (/^(rsc|next-|x-nextjs-|x-middleware-)/i.test(lk)) { hasRscish = true; break; }
        }
        if (hasRscish) {
          hdrs["referer"] = target.toString();
        }
      }
    } catch{}
    // Preserve content-type for POST submissions
    if (method === "POST") {
      const ct = req.headers.get("content-type");
      if (ct) hdrs["content-type"] = ct;
    }
    // For CSRF-sensitive endpoints, present upstream-like Origin/Referer on POST
    if (method === "POST") {
      hdrs["origin"] = target.origin;
      // Use the form action as referer fallback; some apps only check Origin
      hdrs["referer"] = target.toString();
    }

    // Add Referer only for asset requests to satisfy hotlink protections
    if (isAssetReq) hdrs["referer"] = target.toString();

    // Apply a timeout to avoid hanging on unresponsive origins
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const initHeaders: Record<string, string> = { ...hdrs };
      const init: RequestInit = {
        method,
        headers: initHeaders,
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      };
      // Attach any previously stored cookies for this upstream host (including base domain)
      try {
        const initialCookie = buildCookieHeaderForHost(target.hostname, req, jarsUpdated);
        if (initialCookie) initHeaders["cookie"] = initialCookie;
      } catch {}
      if (method === "POST") {
        // Forward the raw body as bytes to avoid stream duplex typing issues
        const buf = await req.arrayBuffer();
        init.body = new Uint8Array(buf);
      }
      // Manual redirect handling to capture Set-Cookie on each hop
      let currentUrl = target.toString();
      let attempts = 0;
      while (true) {
        upstream = await fetch(currentUrl, init);
        const status = upstream.status;
        const loc = upstream.headers.get("location");
        // Record hop debug info
        try {
          const sc = upstream.headers.get("set-cookie");
          const hopCks = sc ? parseSetCookies(sc).map((c) => ({ name: c.name, domain: c.domain })) : undefined;
          debugHops.push({ url: currentUrl, status, location: loc, setCookies: hopCks });
        } catch {}
        // Merge cookies from this response into jar; respect Domain attribute
        try {
          const setCookie = upstream.headers.get("set-cookie");
          if (setCookie) {
            const hostNow = new URL(currentUrl).hostname.toLowerCase();
            const cookies = parseSetCookies(setCookie);
            for (const ck of cookies) {
              const dom = (ck.domain && ck.domain.length) ? ck.domain : hostNow;
              const jarIn = readJar(req, dom);
              const prev = jarsUpdated.get(dom) || jarIn;
              const next = mergeCookieIntoJar({ ...prev }, ck);
              jarsUpdated.set(dom, next);
            }
            // update cookie header targeting the next URL host
            const nextCookie = buildCookieHeaderForHost(new URL(loc || currentUrl, currentUrl).hostname, req, jarsUpdated);
            if (nextCookie) initHeaders["cookie"] = nextCookie;
          }
        } catch {}
        if (!loc || !(status === 301 || status === 302 || status === 303 || status === 307 || status === 308)) {
          break;
        }
        attempts++;
        if (attempts > 5) break;
        // Resolve next URL relative to current
        const nextUrlAbs = new URL(loc, currentUrl).toString();
        // Adjust method per common browser behavior
        if (method === "POST" && (status === 301 || status === 302 || status === 303)) {
          init.method = "GET";
          // Remove any POST body for the redirected GET
          delete (init as Record<string, unknown>).body;
        }
        // Update referer to current URL
        initHeaders["referer"] = currentUrl;
        currentUrl = nextUrlAbs;
      }
      // Also merge final response cookies (non-redirect) into jarsUpdated so they persist
      try {
        const finalSetCookie = upstream.headers.get("set-cookie");
        if (finalSetCookie) {
          const hostNow = new URL(currentUrl).hostname.toLowerCase();
          const cookies = parseSetCookies(finalSetCookie);
          for (const ck of cookies) {
            const dom = (ck.domain && ck.domain.length) ? ck.domain : hostNow;
            const jarIn = readJar(req, dom);
            const prev = jarsUpdated.get(dom) || jarIn;
            const next = mergeCookieIntoJar({ ...prev }, ck);
            jarsUpdated.set(dom, next);
          }
          // Record final hop cookies as well (in case no redirect occurred)
          try {
            const hopCks = parseSetCookies(finalSetCookie).map((c) => ({ name: c.name, domain: c.domain }));
            debugHops.push({ url: currentUrl, status: upstream.status, location: null, setCookies: hopCks });
          } catch {}
        }
      } catch {}
    } finally {
      clearTimeout(timeout);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "Upstream fetch failed", detail: msg, target: target?.toString?.() },
      { status: 502 }
    );
  }

  const passthrough = new Headers(upstream.headers);
  for (const h of BLOCK_HEADERS) passthrough.delete(h);

  const ct = upstream.headers.get("content-type") || "";

  // Persist upstream cookies collected during request/redirect chain for all hosts touched
  const persistJars: Array<{ host: string; json: string }> = [];
  try {
    // Ensure target host is present even if no redirects occurred
    if (!jarsUpdated.has(target.hostname)) {
      const jarIn = readJar(req, target.hostname);
      const setCookie = upstream.headers.get("set-cookie");
      const merged = setCookie ? mergeSetCookie({ ...jarIn }, setCookie) : jarIn;
      jarsUpdated.set(target.hostname, merged);
    }
    for (const [host, jar] of jarsUpdated.entries()) {
      const json = JSON.stringify(jar || {});
      if (json && json !== "{}") persistJars.push({ host, json });
    }
  } catch {}

  // ----- CSS (unchanged) -----
  if (ct.includes("text/css")) {
    const css = await upstream.text();
    const rewritten = rewriteCssUrls(css, proxyOrigin, target);
    const headers = new Headers(passthrough);
    headers.set("content-type", "text/css; charset=utf-8");
    headers.set("cache-control", "no-store");
    const resp = new NextResponse(rewritten, { status: upstream.status, headers });
    try {
      for (const { host, json } of persistJars) {
        resp.cookies.set(jarNameFor(host), json, { httpOnly: false, sameSite: "lax", path: "/" });
      }
    } catch {}
    return resp;
  }

  // ----- HTML (rewrite + inject) -----
  if (ct.includes("text/html")) {
    let html = await upstream.text();

    // Strip meta blockers inside the document (CSP + CSP-Report-Only + XFO)
    html = html
      .replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "")
      .replace(/<meta[^>]+http-equiv=["']Content-Security-Policy-Report-Only["'][^>]*>/gi, "")
      .replace(/<meta[^>]+http-equiv=["']X-Frame-Options["'][^>]*>/gi, "")
      .replace(/<meta[^>]+http-equiv=["']refresh["'][^>]*>/gi, "");

  // We'll inject our script as early as possible in <head> so it runs before site scripts
  // (we'll compute the injection string below and prepend it here)

    const proxyBase = `${proxyOrigin}/api/proxy?url=`;

  // Refined asset detection: only mark typical static file extensions as assets
    const assetExtRe = /\.(?:js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|bmp|webm|mp4|mp3|wav|ogg|woff2?|ttf|otf|map)(?:[?#].*)?$/i;

  // ---------- REWRITE ATTRIBUTES (href/src/srcset/imagesrcset/action/formaction) TAG-SCOPED ----------
  function rewriteTagAttributes(tag: string): string {
    // src/href/action/formaction
    tag = tag.replace(/\s(src|href|action|formaction)\s*=\s*(["'])([^"']*)\2/gi, (_m, attr, q, raw) => {
      const val = decodeHtmlEntities(raw);
      if (!val) return ` ${attr}=${q}${raw}${q}`;
      if (/^(#|mailto:|tel:|javascript:|data:|blob:|about:)/i.test(val)) return ` ${attr}=${q}${raw}${q}`;
      try {
        const test = new URL(val, target);
        if (test.hostname.toLowerCase() === 'about' && /^\/+blank$/i.test(test.pathname)) return ` ${attr}=${q}${raw}${q}`;
      } catch {}
      const abs = absolutize(val, target);
      if (isAlreadyProxied(abs, proxyOrigin)) return ` ${attr}=${q}${abs}${q}`;
      const isAsset = assetExtRe.test(abs);
      const out = `${proxyBase}${encodeURIComponent(abs)}${isAsset ? '&asset=1' : ''}`;
      return ` ${attr}=${q}${out}${q}`;
    });

    // srcset/imagesrcset
    tag = tag.replace(/\s(srcset|imagesrcset)\s*=\s*(["'])([^"']*)\2/gi, (_m, attr, q, raw) => {
      const val = decodeHtmlEntities(raw);
      const parts = String(val)
        .split(',')
        .map((s) => s.trim())
        .filter((x) => x.length > 0);
      const mapped = parts.map((part) => {
        const m = part.match(/^(\S+)(\s+\S+)?$/);
        if (!m) return part;
        const url = m[1];
        const descriptor = m[2] ?? '';
        if (/^(data:|blob:)/i.test(url)) return part;
        try {
          const test = new URL(url, target);
          if (test.hostname.toLowerCase() === 'about' && /^\/+blank$/i.test(test.pathname)) return part;
        } catch {}
        const abs = absolutize(url, target);
        const proxied = isAlreadyProxied(abs, proxyOrigin)
          ? abs
          : `${proxyBase}${encodeURIComponent(abs)}&asset=1`;
        return `${proxied}${descriptor}`;
      });
      return ` ${attr}=${q}${mapped.join(', ')}${q}`;
    });
    return tag;
  }

  html = html.replace(/<[^>]+>/g, (tag) => rewriteTagAttributes(tag));


    // 3) Remove SRI and CORS that would break after rewriting, scoped to tag attributes only
    html = html.replace(/<[^>]+>/g, (tag) => tag.replace(/\s(integrity|crossorigin)\s*=\s*(['"]).*?\2/gi, ""));

    // ----------------------------------------------------------------------

    // Inject helpers (unchanged)
    // Build debug boot info for client runtime
  const cookiesByDomain: Record<string, string[]> = {};
    try {
      for (const [host, jar] of jarsUpdated.entries()) {
        cookiesByDomain[host] = Object.keys(jar || {});
      }
    } catch {}

    const debugBoot = { hops: debugHops, cookiesByDomain };

    const injection = `
      <style id="__annotator_fallback_hover__">
        *:hover { outline: 2px solid rgba(37,99,235,.45) !important; outline-offset: 0 !important; }
      </style>
      <script>
        (function () {
          var PROXY_ORIGIN = ${JSON.stringify(proxyOrigin)};
          var PROXY_BASE = PROXY_ORIGIN + "/api/proxy?url=";
          var BASE = ${JSON.stringify(target.toString())};
          var __PX_DEBUG_BOOT__ = ${JSON.stringify(debugBoot)};
          var __DEBUG_ENABLED__ = true; // enable early to capture initial errors
          // auto-disable after a grace period unless parent keeps it on
          try { setTimeout(function(){ if (typeof __DEBUG_FORCED__ === 'undefined') __DEBUG_ENABLED__ = false; }, 5000); } catch(_){}

          function dbg(kind, data){
            if (!__DEBUG_ENABLED__) return;
            try { window.parent && window.parent.postMessage({ type: 'PROXY_DEBUG', ts: Date.now(), kind: String(kind||'event'), data: data }, '*'); } catch(_) {}
          }
          try { dbg('hops', __PX_DEBUG_BOOT__.hops); dbg('cookies-by-domain', __PX_DEBUG_BOOT__.cookiesByDomain); } catch(_){ }

          // Navigation progress helpers
          var __navTimer = null;
          function navStart(){
            try { window.parent && window.parent.postMessage({ type: 'PROXY_NAV_START' }, '*'); } catch(_) {}
            if (__navTimer) { try { clearTimeout(__navTimer); } catch(_) {} __navTimer = null; }
          }
          function navEndSoon(delay){
            if (delay == null) delay = 700;
            try { if (__navTimer) clearTimeout(__navTimer); } catch(_) {}
            __navTimer = setTimeout(function(){ try { window.parent && window.parent.postMessage({ type: 'PROXY_NAV_END' }, '*'); dbg('nav-end'); } catch(_) {} }, delay);
          }

          function toAbs(h){ try { return new URL(h, BASE).toString(); } catch { return h; } }
          function isProxied(h){
            try {
              var u = new URL(h, PROXY_ORIGIN);
              return u.origin === PROXY_ORIGIN && u.pathname.indexOf("/api/proxy") === 0;
            } catch { return false; }
          }
          function remapIfAppOrigin(uStr){
            try {
              var u = new URL(uStr, PROXY_ORIGIN);
              if (u.origin === PROXY_ORIGIN && u.pathname.indexOf('/api/proxy') !== 0) {
                // Remap to external BASE origin, keep path + search
                var base = new URL(BASE);
                return new URL(u.pathname + u.search, base.origin).toString();
              }
            } catch {}
            return uStr;
          }
          function isAboutBlankLike(h){
            try {
              if (typeof h === 'string' && /^about:(?:blank)?$/i.test(h.trim())) return true;
              var u = new URL(h, BASE);
              if (u.hostname && u.hostname.toLowerCase() === 'about' && /^\\/+blank$/i.test(u.pathname)) return true;
            } catch {}
            return false;
          }
          // Capture original navigation functions/setters to avoid recursion
          var __ORIG_ASSIGN__ = (function(){ try { return window.location.assign.bind(window.location); } catch(_) { return null; } })();
          var __ORIG_REPLACE__ = (function(){ try { return window.location.replace.bind(window.location); } catch(_) { return null; } })();
          var __HREF_SETTER__ = (function(){ try { var d=Object.getOwnPropertyDescriptor(Location.prototype,'href'); return d && d.set && d.set.bind(window.location); } catch(_) { return null; } })();
          var __IN_GO__ = false;
          var __LAST_GO_URL__ = null;
          var __LAST_GO_TS__ = 0;

          function go(u){
            if (!u) return;
            if (isAboutBlankLike(u)) return;
            var target = remapIfAppOrigin(u);
            var finalUrl = isProxied(target) ? target : (PROXY_BASE + encodeURIComponent(toAbs(target)));
            if (finalUrl === location.href) return; // avoid reload loop on identical URL
            try {
              var _now = Date.now();
              if (__LAST_GO_URL__ === finalUrl && (_now - __LAST_GO_TS__) < 1200) { dbg('go-suppressed', { reason: 'rate-limit', final: String(finalUrl) }); return; }
              __LAST_GO_URL__ = finalUrl; __LAST_GO_TS__ = _now;
            } catch(_){ }
            navStart();
            dbg('go', { href: String(u), final: String(finalUrl) });
            // Use native primitives to avoid our own interceptors
            try {
              __IN_GO__ = true;
              if (__HREF_SETTER__) { __HREF_SETTER__(finalUrl); return; }
              if (__ORIG_ASSIGN__) { __ORIG_ASSIGN__(finalUrl); return; }
              location.href = finalUrl;
            } finally { __IN_GO__ = false; }
          }

          // Intercept SPA navigations with a gentle fallback (avoid fighting routers)
          function isPlainLeftClick(evt) {
            return evt.button === 0 && !evt.metaKey && !evt.ctrlKey && !evt.shiftKey && !evt.altKey;
          }
          document.addEventListener("click", function (e) {
            try {
              if (!isPlainLeftClick(e)) return;
              var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
              if (!a) return;
              var href = a.getAttribute("href");
              if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("about:") || isAboutBlankLike(href)) return;
              var tgt = (a.getAttribute("target") || "").toLowerCase();
              dbg('click', { href: href, target: tgt });
              var wouldBeAppOrigin = false;
              try {
                var probe = new URL(href, PROXY_ORIGIN);
                if (probe.origin === PROXY_ORIGIN && probe.pathname.indexOf('/api/proxy') !== 0) wouldBeAppOrigin = true;
              } catch(_) {}
              try { if (isProxied(href)) { e.preventDefault(); go(href); return; } } catch(_){ }
              var before = location.href;
              var done = false;
              var timer = setTimeout(function(){ if (done) return; var now = location.href; if (now === before || (tgt && tgt !== "_self")) { go(href); } }, 300);
              var cancel = function(){ if (done) return; done = true; clearTimeout(timer); };
              var onNav = function(){ cancel(); document.removeEventListener('popstate', onNav); document.removeEventListener('hashchange', onNav); };
              document.addEventListener('popstate', onNav, { once: true });
              document.addEventListener('hashchange', onNav, { once: true });
              if (tgt && tgt !== "_self") {
                e.preventDefault();
                try {
                  var purl = toProxiedUrl(href);
                  dbg('open', { from: href, to: purl, target: tgt });
                  window.open(purl, (tgt === '_blank' ? '' : tgt) || '_blank');
                } catch(_) { go(href); }
                return;
              }
              if (wouldBeAppOrigin) { e.preventDefault(); dbg('prevent-default', { reason: 'app-origin', href: href }); go(href); }
            } catch(_){ }
          }, true);

          document.addEventListener("submit", function (e) {
            try {
              var form = e.target;
              var submitter = (e && e.submitter) ? e.submitter : null;
              var actFromSubmitter = null; var methFromSubmitter = null;
              try { if (submitter && submitter.formAction != null) actFromSubmitter = String(submitter.formAction); } catch(_){ }
              try { if (submitter && submitter.formMethod != null) methFromSubmitter = String(submitter.formMethod).toUpperCase(); } catch(_){ }
              var action = (actFromSubmitter && actFromSubmitter.trim() !== '') ? actFromSubmitter : (form.getAttribute("action") || BASE);
              function toAbs(h){ try { return new URL(h, BASE).toString(); } catch { return h; } }
              function isProxied(h){ try { var u=new URL(h, PROXY_ORIGIN); return u.origin===PROXY_ORIGIN && u.pathname.indexOf('/api/proxy')===0; } catch { return false; } }
              if (action && String(action).trim() !== '' && !isProxied(action)) {
                var proxied = PROXY_BASE + encodeURIComponent(toAbs(action));
                form.setAttribute('action', proxied);
              }
              navStart();
              try {
                var fd = new FormData(form);
                var fields = {};
                fd.forEach(function(v,k){ if (typeof v === 'string') fields[k]=v; });
                var effMethod = methFromSubmitter || (form.getAttribute('method')||'GET').toUpperCase();
                dbg('submit', { method: effMethod, action: action, proxiedAction: form.getAttribute('action'), inputs: fields });
              } catch(_){ }
            } catch (_) {}
          }, true);

          document.addEventListener("submit", function (e) {
            try {
              var form = e.target;
              var action = form.getAttribute("action") || BASE;
              // Ensure action is proxied but allow the browser to submit normally (POST/GET)
              function toAbs(h){ try { return new URL(h, BASE).toString(); } catch { return h; } }
              function isProxied(h){ try { var u=new URL(h, PROXY_ORIGIN); return u.origin===PROXY_ORIGIN && u.pathname.indexOf('/api/proxy')===0; } catch { return false; } }
              if (!isProxied(action)) {
                var proxied = PROXY_BASE + encodeURIComponent(toAbs(action));
                form.setAttribute('action', proxied);
              }
              navStart();
              try {
                var fd = new FormData(form);
                var fields = {};
                fd.forEach(function(v,k){ if (typeof v === 'string') fields[k]=v; });
                dbg('submit', { method: (form.getAttribute('method')||'GET').toUpperCase(), action: action, proxiedAction: form.getAttribute('action'), inputs: fields });
              } catch(_){}
            } catch (_) {}
          }, true);

          function toProxiedUrl(u) {
            var norm = remapIfAppOrigin(u);
            if (isProxied(norm)) return norm;
            return PROXY_BASE + encodeURIComponent(toAbs(norm));
          }
          function normalizeUrlArg(u){
            try {
              if (typeof u === 'string') return u;
              if (u && typeof u === 'object') {
                // URL instance or object with href
                if (typeof u.href === 'string') return u.href;
                // Fallback stringification
                return String(u);
              }
            } catch {}
            return typeof u === 'undefined' ? undefined : String(u);
          }
          var wrap = function(fn){
            return function(state, title, url){
              var argUrl = normalizeUrlArg(url);
              try {
                if (argUrl) {
                  var proxied = toProxiedUrl(argUrl);
                  if (proxied && proxied !== argUrl) {
                    try {
                      var isSameOrigin = false;
                      try { isSameOrigin = new URL(proxied, location.href).origin === location.origin; } catch(_) {}
                      if (!isSameOrigin) throw new Error('cross-origin-url');
                      var r = fn.call(this, state, title, proxied);
                      navStart(); navEndSoon(800);
                      dbg('history', { type: fn === history.pushState ? 'pushState' : 'replaceState', url: argUrl, proxied: proxied, mode: 'rewrite' });
                      return r;
                    } catch (e) {
                      // Fallback if browsers reject or URL would be cross-origin
                      dbg('history-fallback', { reason: (e && (e.name || e.message)) || 'error', url: argUrl, proxied: proxied });
                      go(argUrl);
                      return;
                    }
                  }
                }
              } catch(_){ }
              return fn.apply(this, arguments);
            };
          };
          try { history.pushState = wrap(history.pushState); history.replaceState = wrap(history.replaceState); } catch (_) {}
          // Intercept programmatic navigations to app-origin via location.assign/replace and href setter
          try {
            if (window.location && window.location.assign) {
              var __WRAP_ASSIGN__ = function(u){ try { if (!__IN_GO__) go(u); else __ORIG_ASSIGN__ && __ORIG_ASSIGN__(u); } catch(_) { __ORIG_ASSIGN__ && __ORIG_ASSIGN__(u); } };
              window.location.assign = __WRAP_ASSIGN__;
            }
          } catch(_){ }
          try {
            if (window.location && window.location.replace) {
              var __WRAP_REPLACE__ = function(u){ try { if (!__IN_GO__) go(u); else __ORIG_REPLACE__ && __ORIG_REPLACE__(u); } catch(_) { __ORIG_REPLACE__ && __ORIG_REPLACE__(u); } };
              window.location.replace = __WRAP_REPLACE__;
            }
          } catch(_){ }
          try {
            var hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
            if (hrefDesc && hrefDesc.set) {
              Object.defineProperty(Location.prototype, 'href', {
                configurable: true,
                get: hrefDesc.get,
                set: function(v){ try { if (!__IN_GO__) go(v); else hrefDesc.set.call(this, v); } catch(_) { hrefDesc.set.call(this, v); } }
              });
            }
          } catch(_){ }
          try {
            var __ORIG_OPEN__ = window.open;
            window.open = function(u, name, specs){
              try { var p = toProxiedUrl(u); dbg('open', { from: u, to: p, name: name, specs: specs }); return __ORIG_OPEN__.call(window, p, name || '_blank', specs); } catch(_) { return __ORIG_OPEN__.call(window, u, name || '_blank', specs); }
            };
          } catch (_){ }

          // ---------- NEW: force all runtime resources to proxy against original origin ----------
          var ASSET_EXT_RE = /\\.(?:js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|bmp|webm|mp4|mp3|wav|ogg|woff2?|ttf|otf|map)(?:[?#].*)?$/i;

          function toExternal(uStr) {
            try {
              // If caller gives app-origin absolute like /static/..., map it to external BASE origin
              var probe = new URL(uStr, PROXY_ORIGIN);
              if (probe.origin === PROXY_ORIGIN && probe.pathname.indexOf('/api/proxy') !== 0) {
                var base = new URL(BASE);
                return new URL(probe.pathname + probe.search, base.origin).toString();
              }
            } catch {}
            try { return new URL(uStr, BASE).toString(); } catch { return uStr; }
          }
          function proxify(uStr, forceAsset) {
            try {
              if (uStr == null) return uStr;
              var s = String(uStr);
              if (s.trim() === '') return uStr;
              var externalAbs = toAbs(toExternal(uStr));
              if (isProxied(externalAbs)) return externalAbs;
              var markAsset = forceAsset || ASSET_EXT_RE.test(externalAbs);
              var out = PROXY_BASE + encodeURIComponent(externalAbs) + (markAsset ? "&asset=1" : "");
              if (markAsset) dbg('asset-proxify', { from: uStr, to: out }); else dbg('proxify', { from: uStr, to: out });
              return out;
            } catch { return uStr; }
          }
          function rewriteSrcSet(val) {
            return String(val).split(",").map(function (s) { return s.trim(); }).filter(Boolean).map(function (part) {
              var m = part.match(/^(\\S+)(\\s+\\S+)?$/);
              if (!m) return part;
              var url = m[1], desc = m[2] || "";
              return proxify(url, true) + desc;
            }).join(", ");
          }

          // Patch Element.setAttribute for src/href/srcset/imagesrcset/formaction with guards
          (function () {
            var orig = Element.prototype.setAttribute;
            var inSet = false;
            Element.prototype.setAttribute = function (name, value) {
              if (inSet) return orig.call(this, name, value);
              try {
                var newVal = value;
                var lname = String(name || '').toLowerCase();
                if (lname === "src" || lname === "href") newVal = proxify(value, lname === "src");
                else if (lname === "srcset" || lname === "imagesrcset") newVal = rewriteSrcSet(value);
                else if (lname === "formaction") {
                  var sv = (value == null ? '' : String(value));
                  if (sv.trim() !== '') newVal = proxify(value, false);
                }
                // Skip if unchanged
                if (typeof newVal === 'string') {
                  var cur = this.getAttribute ? this.getAttribute(name) : null;
                  if (cur === newVal) return; // setAttribute returns void normally
                }
                inSet = true;
                var res = orig.call(this, name, newVal);
                inSet = false;
                return res;
              } catch(_) { return orig.call(this, name, value); }
            };
          })();

          // Patch common URL properties
          function defineUrlProp(ctor, prop, asset) {
            try {
              var d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
              if (!d || !d.set) return;
              Object.defineProperty(ctor.prototype, prop, {
                configurable: true,
                get: d.get,
                set: function (v) {
                  try { d.set.call(this, proxify(v, asset)); } catch (_) { d.set.call(this, v); }
                }
              });
            } catch {}
          }
          defineUrlProp(HTMLImageElement, "src", true);
          defineUrlProp(HTMLScriptElement, "src", true);
          defineUrlProp(HTMLLinkElement, "href", false);
          defineUrlProp(HTMLSourceElement, "src", true);
          defineUrlProp(HTMLMediaElement, "src", true);
          try { defineUrlProp(HTMLButtonElement, "formAction", false); } catch(_) {}
          try { defineUrlProp(HTMLInputElement, "formAction", false); } catch(_) {}

          // Patch fetch and XHR
          (function () {
            if (window.fetch) {
              var ofetch = window.fetch;
              window.fetch = function(input, init) {
                try {
                  var u = typeof input === "string" ? input : (input && input.url) || String(input);
                  var fixed = proxify(u, false);
                  dbg('fetch', { from: u, to: fixed, method: (init && init.method) || 'GET' });
                  if (typeof input === "string") {
                    var p = ofetch(fixed, init);
                    try { return p.then(function(resp){ try { dbg('fetch-resp', { url: fixed, status: resp.status, redirected: resp.redirected, type: resp.type, urlFinal: resp.url }); } catch(_) {} return resp; }); } catch(_) { return p; }
                  }
                  if (input && input.url) {
                    var p2 = ofetch(new Request(fixed, input), init);
                    try { return p2.then(function(resp){ try { dbg('fetch-resp', { url: fixed, status: resp.status, redirected: resp.redirected, type: resp.type, urlFinal: resp.url }); } catch(_) {} return resp; }); } catch(_) { return p2; }
                  }
                } catch {}
                return ofetch(input, init);
              };
            }
            if (window.XMLHttpRequest) {
              var oopen = XMLHttpRequest.prototype.open;
              var osend = XMLHttpRequest.prototype.send;
              XMLHttpRequest.prototype.open = function(method, url) {
                try { var orig = url; url = proxify(url, false); dbg('xhr', { method: method, from: orig, to: url }); } catch {}
                return oopen.apply(this, [method, url].concat([].slice.call(arguments, 2)));
              };
              XMLHttpRequest.prototype.send = function(body) {
                try {
                  var self = this;
                  var onReady = function(){ try { if (self.readyState === 4) dbg('xhr-resp', { status: self.status, responseURL: self.responseURL }); } catch(_) {} };
                  if (this.addEventListener) this.addEventListener('readystatechange', onReady);
                } catch(_) {}
                return osend.apply(this, arguments);
              };
            }
          })();

          // Disable Service Worker registration inside proxied context to avoid scope/origin clashes
          try {
            if (navigator && navigator.serviceWorker && navigator.serviceWorker.register) {
              var oreg = navigator.serviceWorker.register.bind(navigator.serviceWorker);
              navigator.serviceWorker.register = function(url, options){
                try { dbg('serviceworker-register-blocked', { url: String(url) }); } catch(_){ }
                // Soft-noop: pretend registration succeeded (most apps are resilient)
                return Promise.resolve(undefined);
              };
            }
          } catch(_){ }

          // Patch EventSource and sendBeacon
          try {
            if (window.EventSource) {
              var OES = window.EventSource;
              window.EventSource = function(url, conf){
                var from = url; var to = proxify(url, false);
                dbg('eventsource', { from: from, to: to });
                return new OES(to, conf);
              };
              window.EventSource.prototype = OES.prototype;
              window.EventSource.CONNECTING = OES.CONNECTING;
              window.EventSource.OPEN = OES.OPEN;
              window.EventSource.CLOSED = OES.CLOSED;
            }
          } catch(_) {}
          try {
            if (navigator && navigator.sendBeacon) {
              var ob = navigator.sendBeacon.bind(navigator);
              navigator.sendBeacon = function(url, data){
                var from = url; var to = proxify(url, false);
                dbg('beacon', { from: from, to: to });
                try { return ob(to, data); } catch(_){ return ob(url, data); }
              };
            }
          } catch(_) {}

          // Patch Worker and SharedWorker to inject fetch/XHR proxies in worker context
          (function(){
            function makeBoot(src){
              var code = [
                'var PROXY_ORIGIN = '+JSON.stringify(PROXY_ORIGIN)+';',
                'var PROXY_BASE = PROXY_ORIGIN + "/api/proxy?url=";',
                'var BASE = '+JSON.stringify(BASE)+';',
                'function toAbs(h){ try { return new URL(h, BASE).toString(); } catch { return h; } }',
                'function toExternal(uStr){ try { var probe=new URL(uStr, PROXY_ORIGIN); if (probe.origin===PROXY_ORIGIN && probe.pathname.indexOf("/api/proxy")!==0){ var base=new URL(BASE); return new URL(probe.pathname+probe.search, base.origin).toString(); } } catch{} try { return new URL(uStr, BASE).toString(); } catch { return uStr; } }',
                'function isProxied(h){ try { var u=new URL(h, PROXY_ORIGIN); return u.origin===PROXY_ORIGIN && u.pathname.indexOf("/api/proxy")==0; } catch { return false; } }',
                'function proxify(uStr){ try { var ext=toAbs(toExternal(uStr)); if (isProxied(ext)) return ext; return PROXY_BASE + encodeURIComponent(ext); } catch { return uStr; } }',
                '(function(){ if (self.fetch){ var of=self.fetch; self.fetch=function(i,init){ try { var u=typeof i==="string"?i:(i&&i.url)||String(i); var fx=proxify(u); if (typeof i==="string") return of(fx,init); if (i&&i.url) return of(new Request(fx,i),init); } catch{} return of(i,init); }; } if (self.XMLHttpRequest){ var oo=self.XMLHttpRequest.prototype.open; self.XMLHttpRequest.prototype.open=function(m,u){ try{ u=proxify(u); }catch{} return oo.apply(this,[m,u].concat([].slice.call(arguments,2))); }; } if (self.EventSource){ var OES=self.EventSource; self.EventSource=function(u,c){ return new OES(proxify(u),c); }; self.EventSource.prototype=OES.prototype; self.EventSource.CONNECTING=OES.CONNECTING; self.EventSource.OPEN=OES.OPEN; self.EventSource.CLOSED=OES.CLOSED; } })();',
                'importScripts('+JSON.stringify(src)+');'
              ].join('\\n');
              return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
            }
            try {
              if (window.Worker) {
                var OW = window.Worker;
                window.Worker = function(url, opts){
                  var prox = proxify(url, false);
                  // Module workers cannot be loaded via importScripts; fallback to plain proxied URL
                  if (opts && opts.type === 'module') {
                    dbg('worker-module', { from: url, to: prox });
                    return new OW(prox, opts);
                  }
                  var b = makeBoot(prox);
                  dbg('worker', { from: url, to: prox });
                  var w = new OW(b, opts);
                  // Do not revoke immediately; keep URL valid to avoid races
                  return w;
                };
                window.Worker.prototype = OW.prototype;
              }
              if (window.SharedWorker) {
                var OSW = window.SharedWorker;
                window.SharedWorker = function(url, opts){
                  var prox = proxify(url, false);
                  if (opts && opts.type === 'module') {
                    dbg('sharedworker-module', { from: url, to: prox });
                    return new OSW(prox, opts);
                  }
                  var b = makeBoot(prox);
                  dbg('sharedworker', { from: url, to: prox });
                  var sw = new OSW(b, opts);
                  return sw;
                };
                window.SharedWorker.prototype = OSW.prototype;
              }
            } catch(_){}
          })();

          // MutationObserver to fix dynamically added nodes/attributes
          function fixAttrs(el) {
            try {
              if (!el || !el.getAttribute) return;
              var v;
              if (el.hasAttribute && el.hasAttribute("src")) {
                v = el.getAttribute("src"); var p = proxify(v, true); if (p && p !== v) el.setAttribute("src", p);
              }
              if (el.hasAttribute && el.hasAttribute("href")) {
                v = el.getAttribute("href"); var p2 = proxify(v, false); if (p2 && p2 !== v) el.setAttribute("href", p2);
              }
              if (el.hasAttribute && el.hasAttribute("formaction")) {
                v = el.getAttribute("formaction"); var pfa = proxify(v, false); if (pfa && pfa !== v) el.setAttribute("formaction", pfa);
              }
              if (el.hasAttribute && el.hasAttribute("srcset")) {
                v = el.getAttribute("srcset"); var p3 = rewriteSrcSet(v); if (p3 && p3 !== v) el.setAttribute("srcset", p3);
              }
              if (el.hasAttribute && el.hasAttribute("imagesrcset")) {
                v = el.getAttribute("imagesrcset"); var p4 = rewriteSrcSet(v); if (p4 && p4 !== v) el.setAttribute("imagesrcset", p4);
              }
              var xlink = el.getAttribute && el.getAttribute("xlink:href");
              if (xlink) {
                var px = proxify(xlink, true); if (px && px !== xlink) el.setAttribute("xlink:href", px);
              }
            } catch {}
          }
          var mo = new MutationObserver(function(muts) {
            muts.forEach(function(m) {
              if (m.type === "attributes" && m.target) {
                fixAttrs(m.target);
              } else if (m.type === "childList" && m.addedNodes) {
                m.addedNodes.forEach(function(n) {
                  if (n && n.nodeType === 1) {
                    fixAttrs(n);
                    if (n.querySelectorAll) {
                      n.querySelectorAll("[src],[href],[formaction],[srcset],[imagesrcset],[xlink\\\\:href]").forEach(fixAttrs);
                    }
                  }
                });
              }
            });
          });
          try {
            mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src","href","formaction","srcset","imagesrcset","xlink:href"] });
            // Initial sweep
            document.querySelectorAll("[src],[href],[formaction],[srcset],[imagesrcset],[xlink\\:href]").forEach(fixAttrs);
          } catch {}

          // Signal load complete to parent to hide spinners
          try {
            window.addEventListener('load', function(){ try { window.parent && window.parent.postMessage({ type: 'PROXY_NAV_END' }, '*'); dbg('load', { href: location.href }); } catch(_) {} });
          } catch(_) {}

          // Extra diagnostics: enumerate forms and capture submit triggers
          try {
            var logForms = function(){
              try {
                var forms = Array.prototype.slice.call(document.querySelectorAll('form'));
                var info = forms.map(function(f){
                  return {
                    id: f.id || undefined,
                    name: f.getAttribute('name') || undefined,
                    action: f.getAttribute('action') || '',
                    method: (f.getAttribute('method') || 'GET').toUpperCase(),
                  };
                });
                dbg('forms-found', info);
                forms.forEach(function(f){
                  try {
                    f.addEventListener('submit', function(ev){
                      try { dbg('submit-capture', { action: f.getAttribute('action') || '', method: (f.getAttribute('method') || 'GET').toUpperCase() }); } catch(_){ }
                    }, true);
                  } catch(_){}
                });
              } catch(_){}
            };
            if (document.readyState === 'complete' || document.readyState === 'interactive') { logForms(); }
            else { document.addEventListener('DOMContentLoaded', function(){ try { logForms(); } catch(_){} }, { once: true }); }
            // Log submit button clicks and Enter key submits
            document.addEventListener('click', function(e){
              try {
                var t = e.target && e.target.closest ? e.target.closest('button, input[type=submit]') : null;
                if (!t) return;
                var type = (t.getAttribute('type') || '').toLowerCase();
                if (type === 'submit' || t.tagName === 'BUTTON') {
                  var form = t.form || (t.closest ? t.closest('form') : null);
                  var action = form ? (form.getAttribute('action') || '') : '';
                  var method = form ? ((form.getAttribute('method') || 'GET').toUpperCase()) : undefined;
                  dbg('submit-button-click', { type: type || 'button', action: action, method: method });
                }
              } catch(_){}
            }, true);
            document.addEventListener('keydown', function(e){
              try {
                if (e.key === 'Enter') {
                  var el = e.target;
                  var form = el && el.closest ? el.closest('form') : null;
                  if (form) {
                    var action = form.getAttribute('action') || '';
                    var method = (form.getAttribute('method') || 'GET').toUpperCase();
                    dbg('enter-submit', { action: action, method: method });
                  }
                }
              } catch(_){}
            }, true);
          } catch(_){ }

          // Global error reporting to parent debug panel
          try {
            window.addEventListener('error', function(ev){
              try {
                var info = { message: ev.message, filename: ev.filename, lineno: ev.lineno, colno: ev.colno };
                try { info.stack = ev.error && ev.error.stack; } catch(_){ }
                dbg('error', info);
              } catch(_){ }
            });
            window.addEventListener('unhandledrejection', function(ev){
              try {
                var r = ev && ev.reason; var msg = r ? (r.message || String(r)) : 'unhandledrejection';
                var info = { message: msg };
                try { info.stack = r && r.stack; } catch(_){ }
                dbg('unhandledrejection', info);
              } catch(_){ }
            });
          } catch(_){ }

          // Debug toggle from parent
          try {
            window.addEventListener('message', function(ev){
              try {
                var d = ev && ev.data; if (!d || typeof d !== 'object') return;
                if (d.type === 'PROXY_DEBUG_ENABLE') { __DEBUG_ENABLED__ = !!d.value; try { __DEBUG_FORCED__ = true; } catch(_){} dbg('debug-toggle', { enabled: __DEBUG_ENABLED__ }); }
                if (d.type === 'PROXY_NAV_TO' && d.url) { dbg('nav-to', { url: String(d.url) }); go(String(d.url)); }
              } catch(_){ }
            });
          } catch(_){ }
          try { window.parent && window.parent.postMessage({ type: 'PROXY_DEBUG', ts: Date.now(), kind: 'ready', data: { href: location.href } }, '*'); } catch(_){}
        })();
      <\/script>
    `;
  // Prepend injection right after <head>
  html = html.replace(/<head([^>]*)>/i, (m) => `${m}\n${injection}`);

    // Optional: return the rewritten HTML as text for debugging line numbers
    const debugHtml = req.nextUrl.searchParams.has("debug_html");
    if (debugHtml) {
      const headers = new Headers({
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      return new NextResponse(html, { status: upstream.status, headers });
    }

    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // keep only frame-ancestors to allow framing by our app
      "content-security-policy": "frame-ancestors 'self'",
    });
    const resp = new NextResponse(html, { status: upstream.status, headers });
    try {
      for (const { host, json } of persistJars) {
        resp.cookies.set(jarNameFor(host), json, { httpOnly: false, sameSite: "lax", path: "/" });
      }
    } catch {}
    return resp;
  }

  // ----- Fallback: stream non-HTML/CSS content (JS, images, fonts, etc.) -----
  {
    const headers = new Headers(passthrough);
    // Remove encoding/length headers because body is already decoded or re-chunked
    stripEncodingHeaders(headers);
    headers.set("cache-control", "no-store");
    headers.set("x-proxy-origin", target.origin);
    const prevVary = headers.get("vary");
    headers.set("vary", prevVary ? `${prevVary}, accept, user-agent` : "accept, user-agent");
    const resp = new NextResponse(upstream.body, { status: upstream.status, headers });
    try {
      for (const { host, json } of persistJars) {
        resp.cookies.set(jarNameFor(host), json, { httpOnly: false, sameSite: "lax", path: "/" });
      }
    } catch {}
    return resp;
  }
}

export async function GET(req: NextRequest) {
  return handleProxy(req, "GET");
}

export async function POST(req: NextRequest) {
  return handleProxy(req, "POST");
}
