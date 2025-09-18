"use client";
import { useEffect, useRef, useState } from "react";
import type { Annotation } from "@/lib/types/annotations";

type Point = { x: number; y: number };

type Props = {
  url: string;
  annotations: Annotation[];
  onSelect: (id: string) => void;
  onCreateAt?: (input: {
    url: string;
    selector: { type: "css"; value: string };
    anchor: Point;
    text: string;
  }) => void;
  onNavigated?: (externalUrl: string) => void; // <-- add this
};

export default function IframeOverlay({ url, annotations, onSelect, onCreateAt, onNavigated }: Props) {
  const [shiftHeld, setShiftHeld] = useState(false);
  // Listen for shift key to enable overlay pointer events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [contentSize, setContentSize] = useState({ width: 1, height: 1 });
  // Ensure overlay releases if Shift state gets stuck (e.g., after prompt)
  useEffect(() => {
    const clear = () => setShiftHeld(false);
    window.addEventListener("blur", clear);
    window.addEventListener("pointerup", clear, true);
    return () => {
      window.removeEventListener("blur", clear);
      window.removeEventListener("pointerup", clear, true);
    };
  }, []);

  // Listen for clicks coming from inside the iframe (if your injected script posts messages)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data as unknown;
      if (typeof data === "object" && data !== null) {
        const rec = data as Record<string, unknown>;
        if (rec.type === "ANNOTATION_CLICK" && typeof rec.id === "string") {
          onSelect(rec.id);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onSelect]);

  // Empty/invalid URL guard
  const src = url?.trim() ? url : "about:blank";

  // Canonicalize a URL. Unwraps /api/proxy?url=... and removes hash, normalizes trailing slash.
  function canonicalize(raw?: string): string {
    if (!raw) return "";
    try {
      const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
      const u = new URL(raw, base);
      // Ignore non-http(s) schemes entirely
      if (!/^https?:$/.test(u.protocol)) return "";
      // Extra guard against protocol-relative about:blank like //about//blank
      if (u.hostname.toLowerCase() === "about" && /^\/+blank$/i.test(u.pathname)) return "";

      let external = raw;
      // Unwrap proxied URLs like /api/proxy?url=<external>
      if (u.pathname.startsWith("/api/proxy")) {
        external = u.searchParams.get("url") ?? "";
      }
      if (!external) return "";

  const e = new URL(external, base);
      if (!/^https?:$/.test(e.protocol)) return "";
  if (e.hostname.toLowerCase() === "about" && /^\/+blank$/i.test(e.pathname)) return "";
      e.hash = "";
      e.pathname = e.pathname.replace(/\/+$/, "") || "/";
      const host = e.port && !["80", "443"].includes(e.port) ? `${e.hostname}:${e.port}` : e.hostname;
      return `${e.protocol}//${host}${e.pathname}${e.search}`;
    } catch {
      return "";
    }
  }

  // Notify parent when iframe navigates to a new URL (poll to handle SPA and link clicks)
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let last = "";
    const tick = () => {
      try {
        const proxied = iframe.contentWindow?.location?.href || iframe.src || "";
        const external = canonicalize(proxied);
        if (external && external !== last) {
          last = external;
          onNavigated?.(external);
        }
      } catch {
        // Cross-origin guards; our proxy keeps it same-origin, so typically safe
      }
    };
    tick();
    const id = setInterval(tick, 400);
    return () => clearInterval(id);
  }, [onNavigated, src]);

  // Only show pins for the current annotated page
  const currentPage = canonicalize(src);
  const visibleAnnotations = annotations.filter(a => canonicalize(a.url) === currentPage);

  // Sync overlay with iframe scroll and content size
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    function updateOverlay() {
      try {
        if (!iframe) return;
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) return;
        const scrollLeft = doc.documentElement.scrollLeft || doc.body.scrollLeft;
        const scrollTop = doc.documentElement.scrollTop || doc.body.scrollTop;
        setScroll({ left: scrollLeft, top: scrollTop });
        const width = doc.documentElement.scrollWidth || doc.body.scrollWidth;
        const height = doc.documentElement.scrollHeight || doc.body.scrollHeight;
        setContentSize({ width, height });
      } catch {}
    }
    updateOverlay();
    const interval = setInterval(updateOverlay, 100); // Polling for cross-origin safety
    return () => clearInterval(interval);
  }, [src]);

  // Also listen for Shift inside the iframe so overlay can capture clicks while focused there
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let detach: (() => void) | null = null;

    const attach = () => {
      try {
        const win = iframe.contentWindow;
        if (!win) return;
        const kd = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(true); };
        const ku = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(false); };
        win.addEventListener("keydown", kd);
        win.addEventListener("keyup", ku);
        detach = () => {
          win.removeEventListener("keydown", kd);
          win.removeEventListener("keyup", ku);
        };
      } catch {}
    };

    // Try immediately and also after a tick (iframe reloads)
    attach();
    const id = setInterval(attach, 300);
    return () => {
      clearInterval(id);
      detach?.();
    };
  }, [src]);

  // Create a pin at click position (Shift+Click)
  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onCreateAt) return;
    // Require Shift; use state to handle iframe focus cases
    if (!shiftHeld && !e.shiftKey) return;
    const el = overlayRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const xPct = (e.clientX - rect.left) / rect.width;
    const yPct = (e.clientY - rect.top) / rect.height;

    // Prompt or send empty text; AnnotatorShell will handle selector fallback to "point"
    const text = window.prompt("Annotation text") ?? "";
    if (!text.trim()) { setShiftHeld(false); return; }

    onCreateAt({
      url: src, // proxied URL; AnnotatorShell canonicalizes to external
      selector: { type: "css", value: "" }, // no CSS selector; coordinates will be used
      anchor: { x: xPct, y: yPct },
      text,
    });
    // Release overlay immediately so browsing resumes
    setShiftHeld(false);
  }

  return (
    <div className="relative w-[95vw] h-[95vh] max-w-full max-h-full overflow-hidden">
      <iframe
        key={src}
        ref={iframeRef}
        src={src}
        className="w-full h-full border-0"
        sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
      />
      <div
        ref={overlayRef}
        className="absolute top-0 left-0"
        style={{
          width: contentSize.width,
          height: contentSize.height,
          pointerEvents: shiftHeld ? "auto" : "none",
          transform: `translate(${-scroll.left}px, ${-scroll.top}px)`
        }}
        onClick={handleOverlayClick}
        title="Shift+Click to add a pin (hold Shift to enable overlay)"
      >
        {visibleAnnotations.map((a: Annotation) => {
          const anchor = a.body?.anchor as Point | undefined;
          const topPx = anchor ? anchor.y * contentSize.height : 20;
          const leftPx = anchor ? anchor.x * contentSize.width : 20;
          return (
            <div
              key={a.id}
              className="absolute bg-red-500 rounded-full w-3 h-3"
              style={{ top: topPx, left: leftPx, transform: "translate(-50%, -50%)", cursor: "pointer" }}
              onClick={(ev) => {
                ev.stopPropagation();
                onSelect(a.id);
              }}
              title={a.body?.text ?? "Annotation"}
            />
          );
        })}
      </div>
    </div>
  );
}
