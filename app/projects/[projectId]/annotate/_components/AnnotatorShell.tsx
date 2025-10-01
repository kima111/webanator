"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import IframeOverlay from "./IframeOverlay";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import AnnotationList from "./AnnotationList";
import MessagePanel from "./MessagePanel";
import type { Annotation } from "@/lib/types/annotations";
import { useAnnotationRealtime, useMessagesRealtime } from "@/lib/hooks/realtime";
import { createClient } from "@/lib/supabase/client";
import { useSearchParams } from "next/navigation";

export default function AnnotatorShell({ projectId, initialUrl }: { projectId: string; initialUrl: string }) {
  const search = useSearchParams();
  useEffect(() => {
    if (search.get("debug") === "1") {
      try { localStorage.setItem("annotatorDebug", "1"); } catch {}
    }
  }, [search]);
  function decodeMaybe(u: string): string {
    if (!u) return u;
    try {
      const once = decodeURIComponent(u);
      if (once !== u && /%[0-9A-Fa-f]{2}/.test(once)) {
        try { return decodeURIComponent(once); } catch { return once; }
      }
      return once;
    } catch { return u; }
  }
  const normalizedInitial = decodeMaybe(initialUrl);
  console.log("[AnnotatorShell] initialUrl", { initialUrl, normalizedInitial });
  const [pageUrl, setPageUrl] = useState<string>(normalizedInitial || "");
  const [tempUrl, setTempUrl] = useState<string>(normalizedInitial || "");
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const lastExternalOriginRef = useRef<string>("");
  const suppressUntilRef = useRef<string | null>(null);

  const { annotations, createAnnotation, announceCreated } = useAnnotationRealtime(projectId);
  const { messages, sendMessage, subscribeTo, deleteMessage } = useMessagesRealtime();
  const subscribeToRef = useRef(subscribeTo);
  useEffect(() => { subscribeToRef.current = subscribeTo; }, [subscribeTo]);

  useEffect(() => {
    if (activeAnnotationId) subscribeToRef.current(activeAnnotationId);
  }, [activeAnnotationId]);

  // Normalize a URL: unwrap /api/proxy?url=..., drop hash, normalize trailing slash
  function canonicalizeUrl(raw: string): string {
    if (!raw) return "";
    try {
      const abs = new URL(raw, window.location.origin);
      // NEW: if internal image viewer, canonicalize by src=
      if (abs.origin === window.location.origin && abs.pathname === "/image-viewer") {
        const src = abs.searchParams.get("src") || "";
        if (!src) return "";
        const s = new URL(src, window.location.origin);
        s.hash = "";
        if (s.pathname !== "/" && s.pathname.endsWith("/")) s.pathname = s.pathname.replace(/\/+$/, "");
        return s.toString();
      }
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

  // Define this early so it's stable for IframeOverlay props
  function handleIframeNavigated(externalUrl: string): void {
    const canonical = canonicalizeUrl(externalUrl);
    // If navigation targets our internal image proxy, keep the image-viewer shell
    try {
      const u = new URL(canonical, window.location.origin);
      const isInternalImage = u.origin === window.location.origin && u.pathname.startsWith("/api/storage/image/");
      if (isInternalImage) {
        const viewer = `/image-viewer?src=${encodeURIComponent(u.pathname + u.search)}`;
        if (suppressUntilRef.current === canonicalizeUrl(viewer)) {
          suppressUntilRef.current = null;
          return;
        }
        setTempUrl(viewer);
        setPageUrl(viewer);
        return;
      }
    } catch {}
    if (suppressUntilRef.current === canonical) {
      suppressUntilRef.current = null;
      return;
    }
    setTempUrl(externalUrl);
    setPageUrl(externalUrl);
  }

  // Normalize to a proxied URL. Accepts raw external URLs and already-proxied URLs.
  function toProxied(raw: string): string {
    if (!raw) return "";
    // Allow direct internal image viewer path
    if (raw.startsWith("/image-viewer")) return raw;
    try {
      const maybe = new URL(raw, window.location.origin);
      if (maybe.origin === window.location.origin) {
        if (maybe.pathname.startsWith("/image-viewer")) return maybe.pathname + maybe.search;
        return maybe.pathname + maybe.search;
      }
    } catch {}
    try {
      let s = raw.trim();
      if (/^(about:|data:|blob:|javascript:|mailto:)/i.test(s)) return "";
      if (s.startsWith("/api/proxy")) return s;
      if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
      const u = new URL(s);
      if (!/^https?:$/.test(u.protocol)) return "";
      if (u.hostname.toLowerCase() === "about" && /^\/+blank$/i.test(u.pathname)) return "";
      return `/api/proxy?url=${encodeURIComponent(u.toString())}`;
    } catch {
      if (/^(about:|data:|blob:|javascript:|mailto:)/i.test(raw)) return "";
      return `/api/proxy?url=${encodeURIComponent(raw)}`;
    }
  }

  // --- Image project support ---
  function getViewerSrc(v: string): string {
    try {
      const u = new URL(v, window.location.origin);
      if (u.origin === window.location.origin && u.pathname === "/image-viewer") {
        const src = u.searchParams.get("src") || "";
        if (!src) return "";
        try {
          const d1 = decodeURIComponent(src);
          return /%[0-9A-Fa-f]{2}/.test(d1) ? decodeURIComponent(d1) : d1;
        } catch {
          return src;
        }
      }
      // Also treat direct internal storage image path as current image
      if (u.origin === window.location.origin && u.pathname.startsWith("/api/storage/image/")) {
        return u.pathname + u.search;
      }
      return "";
    } catch { return ""; }
  }

  const [images, setImages] = useState<Array<{ path: string; url: string }>>([]);
  const [isImagesLoading, setIsImagesLoading] = useState<boolean>(false);
  const currentImageSrc = getViewerSrc(pageUrl);
  const [isUploading, setIsUploading] = useState(false);
  const [toast, setToast] = useState<null | { kind: "success" | "error"; text: string }>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  function showToast(kind: "success" | "error", text: string) {
    setToast({ kind, text });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000) as unknown as number;
  }

  useEffect(() => {
    // Load project images when the project changes (on mount). Avoid re-fetching on image change to prevent footer flicker.
    (async () => {
      setIsImagesLoading(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/images`, { cache: "no-store", credentials: "include" });
        const out = await res.json().catch(() => ({}));
        const list: Array<{ path: string; url: string }> = Array.isArray(out?.images) ? out.images : [];
        setImages((prev) => {
          const byUrl = new Map<string, { path: string; url: string }>();
          for (const it of prev) byUrl.set(it.url, it);
          for (const it of list) byUrl.set(it.url, it);
          // ensure current image at the time of fetch is present
          const currentAtFetch = getViewerSrc(pageUrl);
          if (currentAtFetch && !byUrl.has(currentAtFetch)) {
            byUrl.set(currentAtFetch, { path: "", url: currentAtFetch });
          }
          return Array.from(byUrl.values());
        });
      } catch {
        // fallback: include current image if no list
        setImages((current) => (current.length ? current : (getViewerSrc(pageUrl) ? [{ path: "", url: getViewerSrc(pageUrl) }] : current)));
      } finally {
        setIsImagesLoading(false);
      }
    })();
  }, [projectId]);

  async function handleAddImages(files: FileList | File[] | null) {
    const arr: File[] = Array.isArray(files) ? (files as File[]) : (files ? Array.from(files) : []);
    if (!arr.length) return;
    try {
      setIsUploading(true);
      const fd = new FormData();
      arr.forEach(f => fd.append("files", f));
      console.log("[AnnotatorShell] starting upload", { count: arr.length, projectId });
      const res = await fetch(`/api/projects/${projectId}/images`, { method: "POST", body: fd, credentials: "include", cache: "no-store" });
      const out = await res.json().catch(() => ({}));
      console.log("[AnnotatorShell] upload response", { status: res.status, ok: res.ok, out });
      if (!res.ok) {
        const msg = out?.error || out?.message || res.statusText || "Upload failed";
        showToast("error", String(msg));
        setInlineError(String(msg));
        return;
      }
      const created: Array<{ path: string; url: string }> = out?.images || [];
      if (!created.length) {
        showToast("error", "No images were uploaded.");
        setInlineError("No images were uploaded.");
        return;
      }
      setImages(prev => {
        const next = new Map<string, { path: string; url: string }>();
        for (const it of prev) next.set(it.url, it);
        for (const it of created) next.set(it.url, it);
        return Array.from(next.values());
      });
      showToast("success", `${created.length} image${created.length > 1 ? "s" : ""} uploaded`);
      setInlineError(null);
      // Navigate to last uploaded
      const last = created[created.length - 1];
      if (last?.url) {
        const viewer = `/image-viewer?src=${encodeURIComponent(last.url)}`;
        setTempUrl(viewer);
        suppressUntilRef.current = canonicalizeUrl(viewer);
        setPageUrl(viewer);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Upload error";
      showToast("error", msg);
      setInlineError(msg);
    } finally {
      setIsUploading(false);
    }
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
  announceCreated();
    if (data?.id) setActiveAnnotationId(data.id);
  }

  // Supabase realtime subscription for annotation updates
  // Deliberately only depend on projectId; re-fetching on pageUrl change causes footer flicker
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("annotations")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "annotations",
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          if (payload.eventType === "UPDATE" && payload.new) {
            // Check if assigned_to changed
            // onAnnotationUpdate(payload.new);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  
  const hasCarousel = Boolean(isImagesLoading || currentImageSrc || images.length > 0);
  const rowsClass = hasCarousel ? "grid-rows-[auto_1fr_auto]" : "grid-rows-[auto_1fr]";
  return (
  <div className={`relative w-full h-full grid ${rowsClass} gap-3`}>
      {toast && typeof window !== "undefined" && createPortal(
        <div
          className={`pointer-events-none fixed top-16 right-4 z-[1000] rounded-md border px-3 py-2 text-sm shadow-md ${
            toast.kind === "success" ? "bg-green-50 text-green-800 border-green-200" : "bg-red-50 text-red-800 border-red-200"
          }`}
        >
          {toast.text}
        </div>,
        document.body
      )}
      <div className="flex gap-2">
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

  <div className="grid grid-cols-12 gap-4 h-full min-h-0">
        <div className="col-span-8 min-h-0">
          <div className="h-full border rounded overflow-hidden relative">
            <IframeOverlay
              url={toProxied(pageUrl)}
              annotations={annotations}
              onSelect={setActiveAnnotationId}
              onCreateAt={handleCreateAt}
              onNavigated={handleIframeNavigated}
              activeId={activeAnnotationId}
            />
          </div>
        </div>

        <div className="col-span-4 h-full min-h-0 flex flex-col gap-4">
          <div className="flex-1 min-h-0 border rounded overflow-hidden">
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
          <div className="h-72 md:h-[32vh] border rounded overflow-hidden">
            {(() => {
              const active: Annotation | null = (annotations || []).find(a => a.id === activeAnnotationId) || null;
              return (
                <MessagePanel
                  annotationId={activeAnnotationId}
                  messages={messages}
                  onSend={sendMessage}
                  onDelete={deleteMessage}
                  activeAnnotation={active}
                />
              );
            })()}
          </div>
        </div>
      </div>
      {(isImagesLoading || currentImageSrc || images.length > 0) && (
        <div className="bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-t px-3 py-3 h-40 z-50">
          <Carousel className="px-6">
            <CarouselContent className="items-center">
              {/* Add new images card */}
              <CarouselItem className="basis-auto">
                <div
                  className={`relative shrink-0 border rounded-md w-28 h-28 flex items-center justify-center hover:bg-muted z-10 ${
                    isUploading ? "opacity-60" : "cursor-pointer"
                  }`}
                  title={isUploading ? "Uploading…" : "Add images"}
                  role="button"
                  tabIndex={0}
                  onPointerDownCapture={(e) => {
                    // prevent Embla from swallowing the click as a drag
                    e.stopPropagation();
                  }}
                  onPointerUpCapture={(e) => {
                    e.stopPropagation();
                  }}
                  onClick={() => {
                    if (isUploading) return;
                    console.log("[AnnotatorShell] add-images tile clicked");
                    fileInputRef.current?.click();
                  }}
                  onMouseDown={(e) => {
                    // fallback: some browsers only allow input.click on mousedown
                    if (isUploading) return;
                    e.stopPropagation();
                  }}
                  onMouseUp={(e) => {
                    if (isUploading) return;
                    e.stopPropagation();
                  }}
                  onTouchStart={(e) => {
                    if (isUploading) return;
                    e.stopPropagation();
                  }}
                  onKeyDown={(e) => {
                    if (isUploading) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                  draggable={false}
                  style={{ touchAction: "manipulation", WebkitUserSelect: "none", userSelect: "none" }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,.png,.jpg,.jpeg,.webp,.gif,.svg"
                    multiple
                    disabled={isUploading}
                    className="hidden"
                    onChange={(e) => {
                        const input = e.currentTarget;
                        const selected = input.files ? Array.from(input.files) : [];
                        console.log("[AnnotatorShell] file input change", { count: selected.length });
                        // reset value to allow re-selecting the same files
                        input.value = "";
                        if (!selected.length) {
                          // user canceled the picker; do nothing
                          return;
                        }
                        void handleAddImages(selected);
                      }}
                  />
                  {isUploading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground pointer-events-none">
                      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      <span>Uploading…</span>
                    </div>
                  ) : (
                    <span className="text-2xl pointer-events-none">＋</span>
                  )}
                </div>
                {inlineError && (
                  <div className="mt-1 w-28 text-[10px] text-red-600 text-center">{inlineError}</div>
                )}
              </CarouselItem>
              {/* Loading skeletons */}
              {isImagesLoading && images.length === 0 && (
                Array.from({ length: 4 }).map((_, i) => (
                  <CarouselItem key={`skeleton-${i}`} className="basis-auto">
                    <div className="shrink-0 border rounded-md w-28 h-28 overflow-hidden">
                      <div className="w-full h-full animate-pulse bg-muted" />
                    </div>
                  </CarouselItem>
                ))
              )}
              {images.map((img, idx) => {
                const isActive = img.url === currentImageSrc;
                const viewerHref = `/image-viewer?src=${encodeURIComponent(img.url)}`;
                return (
                  <CarouselItem key={`${img.path || "current"}-${idx}`} className="basis-auto">
                    <button
                      type="button"
                      className={`shrink-0 border rounded-md w-28 h-28 overflow-hidden ${isActive ? "ring-2 ring-blue-500" : ""}`}
                      onClick={() => {
                        setTempUrl(viewerHref);
                        suppressUntilRef.current = canonicalizeUrl(viewerHref);
                        setPageUrl(viewerHref);
                      }}
                      title={img.url}
                    >
                      {/* We use a private proxy URL that Next/Image can't optimize easily; acceptable here. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt="" className="w-full h-full object-cover" />
                    </button>
                  </CarouselItem>
                );
              })}
            </CarouselContent>
            <CarouselPrevious />
            <CarouselNext />
          </Carousel>
        </div>
      )}
    </div>
  );
}