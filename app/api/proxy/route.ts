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

    // Add Referer only for asset requests to satisfy hotlink protections
    if (isAssetReq) hdrs["referer"] = target.toString();

    // Apply a timeout to avoid hanging on unresponsive origins
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      upstream = await fetch(target.toString(), {
        headers: hdrs,
        redirect: "follow",
        credentials: "omit",
        signal: controller.signal,
      });
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
      if (/^(#|mailto:|tel:|javascript:|data:|blob:|about:)/i.test(val)) return `${attr}=${q}${val}${q}`;
      // Skip about:blank expressed as protocol-relative //about//blank
      try {
        const test = new URL(val, target);
        if (test.hostname.toLowerCase() === "about" && /^\/+blank$/i.test(test.pathname)) {
          return `${attr}=${q}${val}${q}`;
        }
      } catch {}
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
      // Skip about:blank-like URLs that may appear as //about//blank
      try {
        const test = new URL(url, target);
        if (test.hostname.toLowerCase() === "about" && /^\/+blank$/i.test(test.pathname)) return part;
      } catch {}
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
              if (u.hostname && u.hostname.toLowerCase() === 'about' && /^\/+blank$/i.test(u.pathname)) return true;
            } catch {}
            return false;
          }
          function go(u){
            if (!u) return;
            if (isAboutBlankLike(u)) return;
            var target = remapIfAppOrigin(u);
            var finalUrl = isProxied(target) ? target : (PROXY_BASE + encodeURIComponent(toAbs(target)));
            if (finalUrl === location.href) return; // avoid reload loop on identical URL
            location.assign(finalUrl);
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
              // Let SPA handle first; then fallback if URL didn't change shortly
              var before = location.href;
              var done = false;
              var timer = setTimeout(function(){ if (done) return; var now = location.href; if (now === before || tgt && tgt !== "_self") { go(href); } }, 300);
              var cancel = function(){ if (done) return; done = true; clearTimeout(timer); };
              var onNav = function(){ cancel(); document.removeEventListener('popstate', onNav); document.removeEventListener('hashchange', onNav); };
              document.addEventListener('popstate', onNav, { once: true });
              document.addEventListener('hashchange', onNav, { once: true });
              // Prevent browser default only if target is not _self (we navigate in-frame) otherwise allow SPA
              if (tgt && tgt !== "_self") { e.preventDefault(); }
            } catch(_){}
          }, true);

          document.addEventListener("submit", function (e) {
            try {
              var form = e.target;
              var action = form.getAttribute("action") || BASE;
              e.preventDefault();
              go(action);
            } catch (_) {}
          }, true);

          function toProxiedUrl(u) {
            var norm = remapIfAppOrigin(u);
            if (isProxied(norm)) return norm;
            return PROXY_BASE + encodeURIComponent(toAbs(norm));
          }
          var wrap = function(fn){
            return function(state, title, url){
              try {
                if (typeof url === "string") {
                  var proxied = toProxiedUrl(url);
                  if (proxied && proxied !== url) {
                    // Rewrite the URL argument to its proxied equivalent and call the original
                    return fn.call(this, state, title, proxied);
                  }
                }
              } catch(_){}
              return fn.apply(this, arguments);
            };
          };
          try { history.pushState = wrap(history.pushState); history.replaceState = wrap(history.replaceState); } catch (_) {}
          try { window.open = function(u){ go(u); }; } catch (_){}

          // ---------- NEW: force all runtime resources to proxy against original origin ----------
          var ASSET_EXT_RE = /\.(?:js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|bmp|webm|mp4|mp3|wav|ogg|woff2?|ttf|otf|map)(?:[?#].*)?$/i;

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
              var externalAbs = toAbs(toExternal(uStr));
              if (isProxied(externalAbs)) return externalAbs;
              var markAsset = forceAsset || ASSET_EXT_RE.test(externalAbs);
              return PROXY_BASE + encodeURIComponent(externalAbs) + (markAsset ? "&asset=1" : "");
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

          // Patch Element.setAttribute for src/href/srcset/imagesrcset with guards
          (function () {
            var orig = Element.prototype.setAttribute;
            var inSet = false;
            Element.prototype.setAttribute = function (name, value) {
              if (inSet) return orig.call(this, name, value);
              try {
                var newVal = value;
                if (name === "src" || name === "href") newVal = proxify(value, name === "src");
                else if (name === "srcset" || name === "imagesrcset") newVal = rewriteSrcSet(value);
                // Skip if unchanged
                if (typeof newVal === 'string') {
                  var cur = this.getAttribute ? this.getAttribute(name) : null;
                  if (cur === newVal) return cur;
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

          // Patch fetch and XHR
          (function () {
            if (window.fetch) {
              var ofetch = window.fetch;
              window.fetch = function(input, init) {
                try {
                  var u = typeof input === "string" ? input : (input && input.url) || String(input);
                  var fixed = proxify(u, false);
                  if (typeof input === "string") return ofetch(fixed, init);
                  if (input && input.url) return ofetch(new Request(fixed, input), init);
                } catch {}
                return ofetch(input, init);
              };
            }
            if (window.XMLHttpRequest) {
              var oopen = XMLHttpRequest.prototype.open;
              XMLHttpRequest.prototype.open = function(method, url) {
                try { url = proxify(url, false); } catch {}
                return oopen.apply(this, [method, url].concat([].slice.call(arguments, 2)));
              };
            }
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
                      n.querySelectorAll("[src],[href],[srcset],[imagesrcset],[xlink\\\\:href]").forEach(fixAttrs);
                    }
                  }
                });
              }
            });
          });
          try {
            mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src","href","srcset","imagesrcset","xlink:href"] });
            // Initial sweep
            document.querySelectorAll("[src],[href],[srcset],[imagesrcset],[xlink\\\\:href]").forEach(fixAttrs);
          } catch {}

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
