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
    const abs = absolutize(u, base);
    // Avoid double-proxy
    if (isAlreadyProxied(abs, proxyOrigin)) return `url(${q}${abs}${q})`;
    return `url(${q}${proxyOrigin}/api/proxy?url=${encodeURIComponent(abs)}&asset=1${q})`;
  });
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

export async function GET(req: NextRequest) {
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
  try {
    const crossSite = target.origin !== proxyOrigin;
    const ua =
      req.headers.get("user-agent") ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    const acceptLang = req.headers.get("accept-language") ?? "en-US,en;q=0.9";

    // Stricter Accept for SVG/images to satisfy some CDNs
    const accept =
      req.headers.get("accept") ??
      (isImage
        ? "image/svg+xml,image/avif,image/webp,image/*;q=0.8,*/*;q=0.5"
        : isAssetReq
        ? "*/*"
        : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

    // Use full page URL as Referer for assets (common hotlink requirement),
    // otherwise origin root for documents.
    const referer = isAssetReq ? target.toString() : `${target.origin}/`;

    // Do NOT send Origin on GETs; some origins reject it for images/docs.
    const hdrs: Record<string, string> = {
      accept,
      "user-agent": ua,
      "accept-language": acceptLang,
      referer,
      // Force uncompressed upstream bodies to avoid decode mismatches
      "accept-encoding": "identity",
      "sec-fetch-mode": isAssetReq ? "no-cors" : "navigate",
      "sec-fetch-dest": isAssetReq ? (isImage ? "image" : "empty") : "document",
      "sec-fetch-site": crossSite ? "cross-site" : "same-origin",
    };

    upstream = await fetch(target.toString(), {
      headers: hdrs,
      redirect: "follow",
      credentials: "omit",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "Upstream fetch failed", detail: msg },
      { status: 502 }
    );
  }

  const passthrough = new Headers(upstream.headers);
  for (const h of BLOCK_HEADERS) passthrough.delete(h);

  const ct = upstream.headers.get("content-type") || "";

  // ----- CSS (unchanged) -----
  if (ct.includes("text/css")) {
    const css = await upstream.text();
    const rewritten = rewriteCssUrls(css, proxyOrigin, target);
    const headers = new Headers(passthrough);
    headers.set("content-type", "text/css; charset=utf-8");
    headers.set("cache-control", "no-store");
    return new NextResponse(rewritten, { status: upstream.status, headers });
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

    // Inject <base> so relative links resolve against the remote directory
    const dirHref = target.origin + target.pathname.replace(/[^/]*$/, "");
    const baseTag = `<base href="${dirHref}">`;
    html = html.replace(/<head([^>]*)>/i, (m) => `${m}\n${baseTag}`);

    const proxyBase = `${proxyOrigin}/api/proxy?url=`;

    // Refined asset detection: only mark typical static file extensions as assets
    const assetExtRe = /\.(?:js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|bmp|webm|mp4|mp3|wav|ogg|woff2?|ttf|otf|map)(?:[?#].*)?$/i;

    // ---------- REWRITE ATTRIBUTES (href/src/srcset/imagesrcset) ----------
    // 1) href/src
    html = html.replace(/(src|href)\s*=\s*(['"])(.*?)\2/gi, (_m, attr, q, val) => {
      if (/^(#|mailto:|tel:|javascript:|data:|blob:)/i.test(val)) return `${attr}=${q}${val}${q}`;
      const abs = absolutize(val, target);
      if (isAlreadyProxied(abs, proxyOrigin)) return `${attr}=${q}${abs}${q}`;
      const isAsset = assetExtRe.test(abs);
      return `${attr}=${q}${proxyBase}${encodeURIComponent(abs)}${isAsset ? "&asset=1" : ""}${q}`;
    });
// 2) srcset/imagesrcset
html = html.replace(
  /\s(srcset|imagesrcset)\s*=\s*(['"])([^"']+)\2/gi,
  (_m: string, attr: string, q: string, val: string) => {
    const parts = val
      .split(",")
      .map((s: string) => s.trim())
      .filter((x: string): x is string => x.length > 0);

    const mapped = parts.map((part: string) => {
      const m = part.match(/^(\S+)(\s+\S+)?$/);
      if (!m) return part;
      const url = m[1];
      const descriptor = m[2] ?? "";
      if (/^(data:|blob:)/i.test(url)) return part;
      const abs = absolutize(url, target);
      const proxied = isAlreadyProxied(abs, proxyOrigin)
        ? abs
        : `${proxyBase}${encodeURIComponent(abs)}&asset=1`;
      return `${proxied}${descriptor}`;
    });

    return ` ${attr}=${q}${mapped.join(", ")}${q}`;
  }
);


    // 3) Remove SRI and CORS that would break after rewriting
    html = html
      .replace(/\s(integrity|crossorigin)\s*=\s*(['"]).*?\2/gi, "");

    // ----------------------------------------------------------------------

    // Inject helpers (unchanged)
    const injection = `
      <style id="__annotator_fallback_hover__">
        *:hover { outline: 2px solid rgba(37,99,235,.45) !important; outline-offset: 0 !important; }
      </style>
      <script>
        (function () {
          var PROXY_ORIGIN = ${JSON.stringify(proxyOrigin)};
          var PROXY_BASE = PROXY_ORIGIN + "/api/proxy?url=";
          var BASE = ${JSON.stringify(target.toString())};

          function toAbs(h){ try { return new URL(h, BASE).toString(); } catch { return h; } }
          function isProxied(h){
            try {
              var u = new URL(h, PROXY_ORIGIN);
              return u.origin === PROXY_ORIGIN && u.pathname.indexOf("/api/proxy") === 0;
            } catch { return false; }
          }
          function go(u){
            if (!u) return;
            if (isProxied(u)) { location.assign(u); }
            else { location.assign(PROXY_BASE + encodeURIComponent(toAbs(u))); }
          }

          document.addEventListener("click", function (e) {
            var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
            if (!a) return;
            var href = a.getAttribute("href");
            if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;
            e.preventDefault();
            go(href);
          }, true);

          document.addEventListener("submit", function (e) {
            try {
              var form = e.target;
              var action = form.getAttribute("action") || BASE;
              e.preventDefault();
              go(action);
            } catch (_) {}
          }, true);

          var wrap = function(fn){ return function(state, title, url){
            if (typeof url === "string") {
              if (!isProxied(url)) return location.assign(PROXY_BASE + encodeURIComponent(toAbs(url)));
            }
            return fn.apply(this, arguments);
          }};
          try { history.pushState = wrap(history.pushState); history.replaceState = wrap(history.replaceState); } catch (_) {}

          try { window.open = function(u){ go(u); }; } catch (_){}
        })();
      </script>
    `;
    html = html.replace(/<\/head>/i, `${injection}</head>`);

    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // keep only frame-ancestors to allow framing by our app
      "content-security-policy": "frame-ancestors 'self'",
    });
    return new NextResponse(html, { status: upstream.status, headers });
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
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  }
}
