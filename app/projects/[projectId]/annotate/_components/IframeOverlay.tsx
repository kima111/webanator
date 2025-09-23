"use client";
import { useEffect, useRef, useState, Fragment, useMemo } from "react";
import type { CSSProperties } from "react";
import type { Annotation } from "@/lib/types/annotations";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

type Point = { x: number; y: number };

type Props = {
  url: string;
  annotations: Annotation[];
  onSelect: (id: string) => void;
  onCreateAt?: (input: { url: string; selector: { type: "css"; value: string }; anchor: Point; text: string }) => void;
  onNavigated?: (externalUrl: string) => void;
  activeId?: string | null;
};

export default function IframeOverlay({ url, annotations, onSelect, onCreateAt, onNavigated, activeId }: Props) {
  const [shiftHeld, setShiftHeld] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [membersByProject, setMembersByProject] = useState<Record<string, Record<string, { label: string; avatar_url?: string | null }>>>({});

  useEffect(() => {
    if (!activeId) return;
    setDismissed((prev) => {
      if (!prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.delete(activeId);
      return next;
    });
  }, [activeId]);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(true); };
    const handleKeyUp = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(false); };
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
  const [viewerSize, setViewerSize] = useState({ width: 0, height: 0 });
  const [newAnnoOpen, setNewAnnoOpen] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const pendingRef = useRef<{ selector: { type: "css"; value: string }; anchor: Point } | null>(null);

  useEffect(() => {
    const clear = () => setShiftHeld(false);
    window.addEventListener("blur", clear);
    window.addEventListener("pointerup", clear, true);
    return () => {
      window.removeEventListener("blur", clear);
      window.removeEventListener("pointerup", clear, true);
    };
  }, []);

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

  const src = url?.trim() ? url : "about:blank";

  function canonicalize(raw?: string): string {
    if (!raw) return "";
    try {
      const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
      const u = new URL(raw, base);
      if (!/^https?:$/.test(u.protocol)) return "";
      if (u.hostname.toLowerCase() === "about" && /^\/+blank$/i.test(u.pathname)) return "";
      let external = raw;
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
      } catch {}
    };
    tick();
    const id = setInterval(tick, 400);
    return () => clearInterval(id);
  }, [onNavigated, src]);

  const currentPage = canonicalize(src);
  const visibleAnnotations = annotations.filter(a => canonicalize(a.url) === currentPage);

  // Fetch project members for any visible annotation's project to resolve assignee display
  const visibleProjectIds = useMemo(() => Array.from(new Set(visibleAnnotations.map(a => a.project_id).filter(Boolean))), [visibleAnnotations]);
  useEffect(() => {
    (async () => {
      for (const pid of visibleProjectIds) {
        if (!pid) continue;
        if (membersByProject[pid]) continue;
        try {
          const res = await fetch(`/api/projects/${pid}/members`, { cache: "no-store" });
          const out = await res.json();
          const members = Array.isArray(out?.members) ? out.members as Array<{ user_id: string; email?: string | null; username?: string | null; first_name?: string | null; last_name?: string | null; avatar_url?: string | null }> : [];
          const rec: Record<string, { label: string; avatar_url?: string | null }> = {};
          for (const m of members) {
            const label = m.username || [m.first_name, m.last_name].filter(Boolean).join(" ") || m.email || m.user_id;
            rec[m.user_id] = { label, avatar_url: m.avatar_url ?? null };
          }
          if (Object.keys(rec).length) {
            setMembersByProject(prev => ({ ...prev, [pid]: rec }));
          } else {
            setMembersByProject(prev => ({ ...prev, [pid]: {} }));
          }
        } catch {
          // ignore fetch errors; leave empty map
          setMembersByProject(prev => ({ ...prev, [pid]: prev[pid] || {} }));
        }
      }
    })();
  }, [visibleProjectIds, membersByProject]);

  function getAssigneeInfo(a: Annotation): { label: string; avatar_url?: string | null } | null {
    const uid = a.assigned_to;
    if (!uid) return null;
    const projectMap = membersByProject[a.project_id] || {};
    const info = projectMap[uid];
    if (info) return info;
    // Fallback label
    return { label: uid.slice(0, 8), avatar_url: null };
  }

  function getPinColors(a: Annotation, isActive: boolean) {
    if (isActive) return { dot: "#3b82f6", ring: "rgba(59,130,246,0.45)" };
    switch (a.status) {
      case "open": return { dot: "#ef4444", ring: "rgba(239,68,68,0.45)" };
      case "resolved": return { dot: "#10b981", ring: "rgba(16,185,129,0.45)" };
      case "archived": return { dot: "#f59e0b", ring: "rgba(245,158,11,0.45)" };
      default: return { dot: "#6b7280", ring: "rgba(107,114,128,0.45)" };
    }
  }

  function buildSelector(el: Element): string {
    if ((el as HTMLElement).id) {
      const id = (el as HTMLElement).id;
      try {
        if (el.ownerDocument?.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${CSS.escape(id)}`;
      } catch {}
    }
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      if (tag === "html" || tag === "body") { parts.push(tag); break; }
      let part = tag;
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) { if (sib.tagName.toLowerCase() === tag) idx++; sib = sib.previousElementSibling; }
      part += `:nth-of-type(${idx})`;
      parts.push(part);
      node = node.parentElement;
    }
    return parts.reverse().join(" > ");
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onCreateAt) return;
    if (!shiftHeld && !e.shiftKey) return;
    const el = overlayRef.current;
    const iframe = iframeRef.current;
    if (!el || !iframe) return;
    const rect = el.getBoundingClientRect();
    const pageXPct = (e.clientX - rect.left) / rect.width;
    const pageYPct = (e.clientY - rect.top) / rect.height;
    const ifrRect = iframe.getBoundingClientRect();
    const vx = e.clientX - ifrRect.left;
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
        elXPct = (vx - hitRect.left) / Math.max(hitRect.width || 1, 1);
        elYPct = (vy - hitRect.top) / Math.max(hitRect.height || 1, 1);
        elXPct = Math.min(Math.max(elXPct, 0), 1);
        elYPct = Math.min(Math.max(elYPct, 0), 1);
      }
    } catch {}
    pendingRef.current = {
      selector: selector ? { type: "css", value: selector } : { type: "css", value: "" },
      anchor: { x: selector ? elXPct : pageXPct, y: selector ? elYPct : pageYPct },
    };
    setDraftText("");
    setNewAnnoOpen(true);
    setShiftHeld(false);
  }

  async function confirmCreate() {
    if (!onCreateAt) return setNewAnnoOpen(false);
    const pending = pendingRef.current;
    if (!pending) return setNewAnnoOpen(false);
    onCreateAt({ url: src, selector: pending.selector, anchor: pending.anchor, text: draftText.trim() });
    pendingRef.current = null;
    setDraftText("");
    setNewAnnoOpen(false);
  }

  function captureElementContext() {
    try {
      const iframe = iframeRef.current;
      const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
      if (!doc) return null;
      const pending = pendingRef.current;
      let el: Element | null = null;
      if (pending?.selector?.value) el = doc.querySelector(pending.selector.value);
      if (!el) el = doc.elementFromPoint(doc.documentElement.clientWidth / 2, doc.documentElement.clientHeight / 2);
      if (!el) return null;
      const text = (el as HTMLElement).innerText?.trim?.() ?? "";
      const role = (el as HTMLElement).getAttribute?.("role") ?? "";
      const aria = Array.from(el.attributes ?? []).filter(a => a.name.startsWith("aria-")).map(a => `${a.name}=${a.value}`).join(" ");
      const rect = (el as HTMLElement).getBoundingClientRect();
      const html = (el as HTMLElement).outerHTML ?? (el as HTMLElement).innerHTML ?? "";
      return { html, text, role, aria, bbox: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } };
    } catch {
      return null;
    }
  }

  async function askAI() {
    const ctx = captureElementContext();
    setAiLoading(true);
    try {
      const external = canonicalize(src);
      const selector = pendingRef.current?.selector?.value || "";
      const res = await fetch("/api/ai/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: external, selector, context: ctx }) });
      const out = await res.json().catch(() => ({}));
      if (res.ok && out?.suggestion) setDraftText(out.suggestion);
      else setDraftText(out?.error ? `AI error: ${out.error}` : "AI did not return a suggestion.");
    } catch {
      setDraftText("AI request failed.");
    } finally {
      setAiLoading(false);
    }
  }

  function getAnchor(a: Annotation): { x: number; y: number } | null {
    try {
      const sel = a.selector;
      const elRel = a.body?.anchor;
      if (sel?.type === "css" && sel?.value && typeof elRel?.x === "number" && typeof elRel?.y === "number") {
        const iframe = iframeRef.current;
        const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
        const node = doc?.querySelector(sel.value);
        if (node && doc) {
          const nRect = (node as HTMLElement).getBoundingClientRect();
          const scrollLeft = doc.documentElement.scrollLeft || doc.body.scrollLeft || 0;
          const scrollTop = doc.documentElement.scrollTop || doc.body.scrollTop || 0;
          const absX = nRect.left + scrollLeft + nRect.width * elRel.x;
          const absY = nRect.top + scrollTop + nRect.height * elRel.y;
          return { x: absX / Math.max(contentSize.width || 1, 1), y: absY / Math.max(contentSize.height || 1, 1) };
        }
      }
      if (a.selector?.type === "point" && a.selector?.value) {
        const p = JSON.parse(a.selector.value);
        if (typeof p?.x === "number" && typeof p?.y === "number") return p;
      }
      const p = a.body?.anchor;
      if (typeof p?.x === "number" && typeof p?.y === "number") return p;
    } catch {}
    return null;
  }

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    function updateOverlay() {
      try {
        const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
        if (!doc) return;
        const scrollLeft = doc.documentElement.scrollLeft || doc.body.scrollLeft || 0;
        const scrollTop = doc.documentElement.scrollTop || doc.body.scrollTop || 0;
        setScroll({ left: scrollLeft, top: scrollTop });
        const width = doc.documentElement.scrollWidth || doc.body.scrollWidth || 1;
        const height = doc.documentElement.scrollHeight || doc.body.scrollHeight || 1;
        setContentSize({ width, height });
        // visible viewport of the iframe element in outer page coordinates
        const rect = iframe.getBoundingClientRect();
        setViewerSize({ width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) });
      } catch {}
    }
    updateOverlay();
    const interval = setInterval(updateOverlay, 100);
    return () => clearInterval(interval);
  }, [src]);

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
        detach = () => { win.removeEventListener("keydown", kd); win.removeEventListener("keyup", ku); };
      } catch {}
    };
    attach();
    const id = setInterval(attach, 300);
    return () => { clearInterval(id); detach?.(); };
  }, [src]);

  return (
    <>
      <div className="relative w-[95vw] h-[95vh] max-w-full max-h-full">
        <iframe ref={iframeRef} src={src} className="w-full h-full border-0" sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts" />
        <div
          ref={overlayRef}
          className="absolute top-0 left-0"
          style={{ width: contentSize.width, height: contentSize.height, pointerEvents: shiftHeld ? "auto" : "none", transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}
          onClick={handleOverlayClick}
          title="Shift+Click to add a pin (hold Shift to enable overlay)"
        >
          {visibleAnnotations.map((a) => {
            const anchor = getAnchor(a);
            if (!anchor) return null;
            const left = anchor.x * contentSize.width;
            const top = anchor.y * contentSize.height;
            const isActive = !!activeId && a.id === activeId;
            const colors = getPinColors(a, isActive);
            const showBubble = (isActive || shiftHeld) && !dismissed.has(a.id);
            const rawText = (a.body?.text ?? "").trim();
            const limit = isActive ? 1000 : 600;
            const preview = rawText.length > limit ? rawText.slice(0, limit).trimEnd() + "…" : rawText;
            const placeBelow = top < 120;
            return (
              <div
                key={a.id}
                className="absolute"
                style={{ left, top, transform: "translate(-50%, -50%)", pointerEvents: "auto" }}
                onClick={(e) => { e.stopPropagation(); if (a.id) onSelect(a.id); }}
                title={a.body?.text ?? "Annotation"}
              >
                <div
                  className="sonar-pin"
                  style={(() => {
                    type CSSVarStyle = CSSProperties & { [K in `--pin-color` | `--pin-ring`]?: string };
                    const cssVars: CSSVarStyle = {};
                    cssVars["--pin-color"] = colors.dot;
                    cssVars["--pin-ring"] = colors.ring;
                    return cssVars;
                  })()}
                >
                  <span className="dot" />
                  <span className="ring r1" />
                  <span className="ring r2" />
                  <span className="ring r3" />
                </div>

                {showBubble && preview && (() => {
                  // Compute bubble width in px based on visible iframe width
                  const desired = Math.round(viewerSize.width * 0.3);
                  const bubbleW = Math.max(260, Math.min(520, desired || 0));
                  // Clamp the bubble center horizontally within viewer (to avoid spilling outside)
                  const pinX = left - scroll.left; // pin in outer coords
                  const half = bubbleW / 2;
                  const viewerLeft = 0;
                  const viewerRight = viewerSize.width;
                  const clampedCenter = Math.max(viewerLeft + half, Math.min(viewerRight - half, pinX));
                  const offsetX = clampedCenter - pinX; // pixels to shift from pin center
                  return (
                    <div
                      className={`absolute z-10 rounded-md border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-md ${isActive ? "text-base leading-7" : "text-sm leading-6"}`}
                      style={{
                        top: placeBelow ? 16 : -16,
                        left: offsetX,
                        transform: `translate(calc(-50% + ${offsetX}px), ${placeBelow ? 0 : -100}%)`,
                        width: bubbleW,
                        padding: isActive ? "10px 12px" : "8px 10px",
                        wordBreak: "break-word",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                    <button
                      type="button"
                      aria-label="Close preview"
                      className="absolute top-1.5 right-1.5 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDismissed((prev) => new Set(prev).add(a.id));
                      }}
                    >
                      ×
                    </button>
                    {a.assigned_to && (() => {
                      const info = getAssigneeInfo(a);
                      if (!info) return null;
                      const avatar = info.avatar_url || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(info.label)}`;
                      return (
                        <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                          <img src={avatar} alt={info.label} className="h-4 w-4 rounded-full border object-cover" />
                          <span className="truncate">Assigned to {info.label}</span>
                        </div>
                      );
                    })()}
                    <div className={isActive ? "line-clamp-6" : "line-clamp-4"}>
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeSanitize]}
                        components={{
                          p: ({ children }) => <span>{children} </span>,
                          ul: ({ children }) => <span>{children}</span>,
                          ol: ({ children }) => <span>{children}</span>,
                          li: ({ children }) => <span>{children} </span>,
                          a: ({ children }) => <span className="underline">{children}</span>,
                          h1: ({ children }) => <strong>{children}</strong>,
                          h2: ({ children }) => <strong>{children}</strong>,
                          h3: ({ children }) => <strong>{children}</strong>,
                          h4: ({ children }) => <strong>{children}</strong>,
                          h5: ({ children }) => <strong>{children}</strong>,
                          h6: ({ children }) => <strong>{children}</strong>,
                        }}
                      >
                        {preview}
                      </ReactMarkdown>
                    </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>

      <Dialog open={newAnnoOpen} onOpenChange={(open) => { setNewAnnoOpen(open); if (!open) { pendingRef.current = null; setDraftText(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New annotation</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <label className="text-xs text-muted-foreground">Note</label>
            <textarea className="min-h-[96px] w-full rounded border px-2 py-1 text-sm" placeholder="Type your note..." value={draftText} autoFocus onChange={(e) => setDraftText(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewAnnoOpen(false)}>Cancel</Button>
            <Button variant="secondary" onClick={askAI} disabled={aiLoading}>{aiLoading ? "Asking AI…" : "Ask AI"}</Button>
            <Button onClick={confirmCreate} disabled={!draftText.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
