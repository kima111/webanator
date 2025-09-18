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
};

export default function IframeOverlay({ url, annotations, onSelect, onCreateAt }: Props) {
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
      let external = raw;

      // Unwrap proxied URLs like /api/proxy?url=<external>
      if (u.pathname.startsWith("/api/proxy")) {
        external = u.searchParams.get("url") ?? "";
      }

      if (!external) return "";

      const e = new URL(external);
      e.hash = "";
      // Normalize trailing slash (keep "/" for root)
      e.pathname = e.pathname.replace(/\/+$/, "") || "/";
      // Drop default ports
      const host = e.port && !["80", "443"].includes(e.port) ? `${e.hostname}:${e.port}` : e.hostname;
      return `${e.protocol}//${host}${e.pathname}${e.search}`;
    } catch {
      return (raw.split("#")[0] ?? "").replace(/\/+$/, "") || "/";
    }
  }

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

  // Create a pin at click position (Shift+Click)
  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onCreateAt) return;
    if (!e.shiftKey) return; // require Shift to avoid blocking normal interaction
    const el = overlayRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const xPct = (e.clientX - rect.left) / rect.width;
    const yPct = (e.clientY - rect.top) / rect.height;
    // Clamp to [0,1]
    const anchor: Point = {
      x: Math.max(0, Math.min(1, xPct)),
      y: Math.max(0, Math.min(1, yPct)),
    };
    const text = (typeof window !== "undefined" && window.prompt("Add a comment for this pin")?.trim()) || "";
    if (!text) return;
    onCreateAt({
      url: src,
      selector: { type: "css", value: "" },
      anchor,
      text,
    });
  }

  return (
    <div className="relative w-[95vw] h-[95vh] max-w-full max-h-full">
      <iframe
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
