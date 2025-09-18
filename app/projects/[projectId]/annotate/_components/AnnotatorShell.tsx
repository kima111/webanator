"use client";
import { useEffect, useRef, useState } from "react";
import IframeOverlay from "./IframeOverlay";
import AnnotationList from "./AnnotationList";
import MessagePanel from "./MessagePanel";
import { useAnnotationRealtime, useMessagesRealtime } from "@/lib/hooks/realtime";

export default function AnnotatorShell({ projectId, initialUrl }: { projectId: string; initialUrl: string }) {
  const [pageUrl, setPageUrl] = useState<string>(initialUrl || "");
  const [tempUrl, setTempUrl] = useState<string>(initialUrl || "");
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const lastExternalOriginRef = useRef<string>("");
  const suppressUntilRef = useRef<string | null>(null);

  const { annotations, createAnnotation } = useAnnotationRealtime(projectId);
  const { messages, sendMessage, subscribeTo, deleteMessage } = useMessagesRealtime();

  useEffect(() => {
    if (activeAnnotationId) subscribeTo(activeAnnotationId);
  }, [activeAnnotationId, subscribeTo]);

  // Normalize a URL: unwrap /api/proxy?url=..., drop hash, normalize trailing slash
  function canonicalizeUrl(raw: string): string {
    if (!raw) return "";
    try {
      const abs = new URL(raw, window.location.origin);
      let target = abs;
      if (abs.origin === window.location.origin && abs.pathname.startsWith("/api/proxy")) {
        const inner = abs.searchParams.get("url");
        if (inner) target = new URL(inner);
      }
      target.hash = "";
      if (target.pathname !== "/" && target.pathname.endsWith("/")) {
        target.pathname = target.pathname.replace(/\/+$/, "");
      }
      return target.toString();
    } catch {
      return (raw.split("#")[0] ?? "").trim();
    }
  }

  // Track the last known external origin (for remapping SPA navigations)
  useEffect(() => {
    const external = canonicalizeUrl(tempUrl || pageUrl);
    try {
      if (external) lastExternalOriginRef.current = new URL(external).origin;
    } catch {}
  }, [tempUrl, pageUrl]);

  // Normalize to a proxied URL. Accepts raw external URLs and already-proxied URLs.
  function toProxied(raw: string): string {
    if (!raw) return "";
    try {
      let s = raw.trim();
      // Ignore non-http(s) schemes to avoid bad proxy requests
      if (/^(about:|data:|blob:|javascript:|mailto:)/i.test(s)) return "";
      // Already proxied? pass through
      if (s.startsWith("/api/proxy")) return s;
      // Add scheme if user typed a bare domain
      if (!/^https?:\/\//i.test(s)) {
        s = `https://${s}`;
      }
      const u = new URL(s);
      if (!/^https?:$/.test(u.protocol)) return "";
      // Skip protocol-relative about:blank like //about//blank
      if (u.hostname.toLowerCase() === "about" && /^\/+blank$/i.test(u.pathname)) return "";
      return `/api/proxy?url=${encodeURIComponent(u.toString())}`;
    } catch {
      // On parse errors, do not proxy unknown schemes
      if (/^(about:|data:|blob:|javascript:|mailto:)/i.test(raw)) return "";
      return `/api/proxy?url=${encodeURIComponent(raw)}`;
    }
  }

  // When iframe navigates internally, reflect it in the address bar and state
  function handleIframeNavigated(externalUrl: string) {
    // If we initiated a navigation, ignore intermediate updates until we reach the target
    if (suppressUntilRef.current && externalUrl !== suppressUntilRef.current) {
      return;
    }
    if (suppressUntilRef.current && externalUrl === suppressUntilRef.current) {
      suppressUntilRef.current = null;
    }
    // If iframe reports a same-origin, non-proxied path, remap to last external origin
    try {
      const u = new URL(externalUrl, window.location.origin);
      if (u.origin === window.location.origin && !u.pathname.startsWith("/api/proxy")) {
        const base = lastExternalOriginRef.current;
        if (base) {
          const rebuilt = new URL(u.pathname + u.search, base).toString();
          const ext = canonicalizeUrl(rebuilt);
          suppressUntilRef.current = ext;
          setTempUrl(ext);
          setPageUrl(ext);
          return;
        }
      }
    } catch {}
    const ext = canonicalizeUrl(externalUrl);
    setTempUrl(ext);
    setPageUrl(ext);
  }

  async function handleCreateAt(input: {
    url: string;
    selector: { type: "css"; value: string };
    anchor: { x: number; y: number };
    text: string;
  }) {
    const finalUrl = canonicalizeUrl(input.url || pageUrl);
    if (!finalUrl) {
      console.warn("Cannot create annotation: no valid page URL loaded");
      return;
    }

    const hasCss = input.selector?.value && input.selector.value.trim().length > 0;
    const effectiveSelector = hasCss
      ? input.selector
      : { type: "point", value: JSON.stringify(input.anchor) };

    const res = await fetch("/api/annotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        project_id: projectId,
        url: finalUrl,
        selector: effectiveSelector,
        body: { text: input.text, anchor: input.anchor },
        status: "open",
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error("Annotation insert failed", err?.error ?? res.statusText);
      return;
    }
    const data = await res.json().catch(() => ({}));
    await createAnnotation();
    if (data?.id) setActiveAnnotationId(data.id);
  }

  return (
    <div className={`relative w-[95vw] mx-auto h-[calc(100vh-88px)]`}>
      <div className="mb-2 flex gap-2">
        <input
          className="flex-1 border rounded px-2 py-1 text-sm"
          placeholder="https://example.com"
          value={tempUrl}
          onChange={(e) => setTempUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const target = tempUrl;
              suppressUntilRef.current = canonicalizeUrl(target);
              setPageUrl(target);
            }
          }}
        />
        <button
          className="border rounded px-3 py-1 text-sm"
          onClick={() => {
            const target = tempUrl;
            suppressUntilRef.current = canonicalizeUrl(target);
            setPageUrl(target);
          }}
        >
          Load
        </button>
      </div>

      <div className="grid grid-cols-12 gap-4 flex-1 min-h-0">
        <div className="col-span-8 min-h-0">
          <div className="h-full border rounded overflow-hidden relative">
            <IframeOverlay
              url={toProxied(pageUrl)}
              annotations={annotations}
              onSelect={setActiveAnnotationId}
              onCreateAt={handleCreateAt}
              onNavigated={handleIframeNavigated} // <-- reflect in-iframe navigation
            />
          </div>
        </div>
        <div className="col-span-4 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 border rounded">
            <AnnotationList
              items={annotations}
              activeId={activeAnnotationId}
              onSelect={setActiveAnnotationId}
              currentPageUrl={pageUrl}
              onNavigateToUrl={(url) => {
                const target = url;
                setTempUrl(target);
                suppressUntilRef.current = canonicalizeUrl(target);
                setPageUrl(target);
              }}
              refresh={createAnnotation}
            />
          </div>
          {/* Optionally show a small status of current page */}
          {/* <div className="mt-2 text-xs text-muted-foreground truncate">Viewing: {tempUrl}</div> */}
          <div className="mt-4">
            <MessagePanel
              annotationId={activeAnnotationId}
              messages={messages}
              onSend={sendMessage}
              onDelete={deleteMessage}
            />
          </div>
        </div>
      </div>
    </div>
  );
}