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
  onNavigated?: (externalUrl: string) => void;
  /* NEW: active annotation id to highlight */
  activeId?: string | null;
};

export default function IframeOverlay({
  url,
  annotations,
  onSelect,
  onCreateAt,
  onNavigated,
  activeId,
}: Props) {
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

  // Choose pin color by status; override to blue if active
  function getPinColors(a: Annotation, isActive: boolean) {
    if (isActive) {
      return { dot: "#3b82f6", ring: "rgba(59,130,246,0.45)" }; // blue-500
    }
    switch (a.status) {
      case "open":
        return { dot: "#ef4444", ring: "rgba(239,68,68,0.45)" }; // red-500
      case "resolved":
        return { dot: "#10b981", ring: "rgba(16,185,129,0.45)" }; // emerald-500
      case "archived":
        return { dot: "#f59e0b", ring: "rgba(245,158,11,0.45)" }; // amber-500
      default:
        return { dot: "#6b7280", ring: "rgba(107,114,128,0.45)" }; // gray-500
    }
  }

  // Build a reasonably stable CSS selector for an element
  function buildSelector(el: Element): string {
    // Prefer id if unique
    if ((el as HTMLElement).id) {
      const id = (el as HTMLElement).id;
      try {
        if (el.ownerDocument?.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
          return `#${CSS.escape(id)}`;
        }
      } catch {}
    }
    // Build path with nth-of-type to reduce churn
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      // stop at body/html
      if (tag === "html" || tag === "body") {
        parts.push(tag);
        break;
      }
      // If node has a data-* hook or role that could help, you can extend this
      let part = tag;
      // nth-of-type
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName.toLowerCase() === tag) idx++;
        sib = sib.previousElementSibling;
      }
      part += `:nth-of-type(${idx})`;
      parts.push(part);
      node = node.parentElement;
    }
    return parts.reverse().join(" > ");
  }

  // Create a pin at click position (Shift+Click) – element-anchored
  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onCreateAt) return;
    if (!shiftHeld && !e.shiftKey) return;

    const el = overlayRef.current;
    const iframe = iframeRef.current;
    if (!el || !iframe) return;

    // Page-relative position (fallback)
    const rect = el.getBoundingClientRect();
    const pageXPct = (e.clientX - rect.left) / rect.width;
    const pageYPct = (e.clientY - rect.top) / rect.height;

    // Try to resolve the element under the click inside the iframe viewport
    const ifrRect = iframe.getBoundingClientRect();
    const vx = e.clientX - ifrRect.left; // viewport coords inside iframe
    const vy = e.clientY - ifrRect.top;

    let selector: string | null = null;
    let elXPct = pageXPct;
    let elYPct = pageYPct;

    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      const hit = doc?.elementFromPoint(vx, vy) as Element | null;
      if (hit && doc) {
        selector = buildSelector(hit);
        const hitRect = hit.getBoundingClientRect();
        // normalize within the element box
        elXPct = (vx - hitRect.left) / Math.max(hitRect.width || 1, 1);
        elYPct = (vy - hitRect.top) / Math.max(hitRect.height || 1, 1);
        // clamp
        elXPct = Math.min(Math.max(elXPct, 0), 1);
        elYPct = Math.min(Math.max(elYPct, 0), 1);
      }
    } catch {
      // ignore, will use page-relative fallback
    }

    const text = window.prompt("Annotation text") ?? "";
    if (!text.trim()) {
      setShiftHeld(false);
      return;
    }

    onCreateAt({
      url: src, // proxied; server canonicalizes to external
      selector: selector ? { type: "css", value: selector } : { type: "css", value: "" },
      // Store element-relative if we have a selector; otherwise keep page-relative
      anchor: { x: selector ? elXPct : pageXPct, y: selector ? elYPct : pageYPct },
      text,
    });

    setShiftHeld(false);
  }

  function getAnchor(a: Annotation): { x: number; y: number } | null {
    try {
      // If we have a CSS selector, resolve element and convert element-relative -> page-relative
      const sel = (a as any)?.selector;
      const elRel = (a as any)?.body?.anchor;
      if (sel?.type === "css" && sel?.value && typeof elRel?.x === "number" && typeof elRel?.y === "number") {
        const iframe = iframeRef.current;
        const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
        const node = doc?.querySelector(String(sel.value));
        if (node && doc) {
          const nRect = node.getBoundingClientRect();
          const scrollLeft = doc.documentElement.scrollLeft || doc.body.scrollLeft || 0;
          const scrollTop = doc.documentElement.scrollTop || doc.body.scrollTop || 0;
          const absX = nRect.left + scrollLeft + nRect.width * elRel.x;
          const absY = nRect.top + scrollTop + nRect.height * elRel.y;
          // convert to page-relative percentages expected by renderer
          return {
            x: absX / Math.max(contentSize.width || 1, 1),
            y: absY / Math.max(contentSize.height || 1, 1),
          };
        }
      }

      // Fallbacks (point selector or page-relative anchor)
      if ((a as any)?.selector?.type === "point" && (a as any)?.selector?.value) {
        const p = JSON.parse(String((a as any).selector.value));
        if (typeof p?.x === "number" && typeof p?.y === "number") return p;
      }
      const p = (a as any)?.body?.anchor;
      if (typeof p?.x === "number" && typeof p?.y === "number") return p;
    } catch {}
    return null;
  }

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
          transform: `translate(${-scroll.left}px, ${-scroll.top}px)`,
        }}
        onClick={handleOverlayClick}
        title="Shift+Click to add a pin (hold Shift to enable overlay)"
      >
        {/* Pins with sonar animation */}
        {visibleAnnotations.map((a) => {
          const anchor = getAnchor(a);
          if (!anchor) return null;
          const left = anchor.x * contentSize.width;
          const top = anchor.y * contentSize.height;
          const isActive = !!activeId && a.id === activeId;
          const colors = getPinColors(a, isActive);

          return (
            <div
              key={a.id}
              className="absolute"
              style={{
                left,
                top,
                transform: "translate(-50%, -50%)",
                pointerEvents: "auto",
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (a.id) onSelect(a.id);
              }}
              title={(a as any)?.body?.text ?? "Annotation"}
            >
              <div
                className="sonar-pin"
                style={
                  {
                    // feed CSS variables used by globals.css
                    ["--pin-color" as any]: colors.dot,
                    ["--pin-ring" as any]: colors.ring,
                  } as React.CSSProperties
                }
              >
                <span className="dot" />
                <span className="ring r1" />
                <span className="ring r2" />
                <span className="ring r3" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
