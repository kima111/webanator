"use client";
import { useEffect, useRef } from "react";

type Point = { x: number; y: number };
type Ann = { id: string; body?: { text?: string; anchor?: Point } | null };

type Props = {
  url: string;
  annotations: Ann[];
  onSelect: (id: string) => void;
  onCreateAt?: (input: {
    url: string;
    selector: { type: "css"; value: string };
    anchor: Point; // store as 0..1 percentages
    text: string;
  }) => void;
};

export default function IframeOverlay({ url, annotations, onSelect, onCreateAt }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

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
      {/* Overlay captures Shift+Click for new pins and renders existing pins */}
      <div
        ref={overlayRef}
        className="absolute inset-0"
        onClick={handleOverlayClick}
        // Allow interacting with pins while letting iframe receive normal clicks unless Shift is held
        style={{ pointerEvents: "auto" }}
        title="Shift+Click to add a pin"
      >
        {annotations.map((a) => {
          const anchor = a.body?.anchor;
          // Position by anchor percentages if present, else fall back to top-left corner
          const top = anchor ? `${anchor.y * 100}%` : "20px";
          const left = anchor ? `${anchor.x * 100}%` : "20px";
          return (
            <div
              key={a.id}
              className="absolute bg-red-500 rounded-full w-3 h-3"
              style={{ top, left, transform: "translate(-50%, -50%)", cursor: "pointer" }}
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
