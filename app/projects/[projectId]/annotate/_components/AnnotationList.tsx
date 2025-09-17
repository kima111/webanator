"use client";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { Button } from "@/components/ui/button";

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "archived", label: "Archived" },
];

type Ann = {
  id?: string;
  url?: string;
  body?: {
    text?: string;
    display_name?: string;
    time_of_day?: string;
  } | null;
  status?: string | null;
};

export default function AnnotationList({
  items,
  activeId,
  onSelect,
  currentPageUrl,
  onNavigateToUrl,
  refresh, // <-- add this prop
}: {
  items?: Ann[] | null;
  activeId: string | null;
  onSelect?: (id: string) => void;
  currentPageUrl: string;
  onNavigateToUrl?: (url: string) => void;
  refresh?: () => void; // <-- add this prop
}) {
  const safeItems = Array.isArray(items) ? items : [];
  const [deleting, setDeleting] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  async function handleDelete(id?: string) {
    if (!id) return;
    setDeleting(id);
    await fetch(`/api/annotations/${id}`, { method: "DELETE" });
    setDeleting(null);
    refresh?.(); // <-- force refresh after delete
  }

  async function handleStatusChange(id: string, status: string) {
    setUpdating(id);
    await fetch(`/api/annotations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setUpdating(null);
    refresh?.();
  }

  // Helper to build the annotate URL for the project
  // function getAnnotateUrl(annotationUrl?: string) {
  //   if (!annotationUrl) return "#";
  //   // Remove hash, encode, and build the annotate page URL with ?url=
  //   const cleanUrl = annotationUrl.split("#")[0];
  //   return `?url=${encodeURIComponent(cleanUrl)}`;
  // }

  // Normalize URLs for comparison (remove hash, trailing slash, etc.)
  function normalizeUrl(url?: string) {
    if (!url) return "";
    try {
      const u = new URL(url, "http://dummy");
      u.hash = "";
      return u.toString().replace("http://dummy", "");
    } catch {
      return url.split("#")[0];
    }
  }

  const normalizedCurrent = normalizeUrl(currentPageUrl);

  return (
    <div className="overflow-auto h-full divide-y">
      {safeItems.map((a, idx) => {
        const isCurrent =
          normalizeUrl(a.url) === normalizedCurrent ||
          decodeURIComponent(normalizeUrl(a.url)) === normalizedCurrent;

        return (
          <div
            key={a.id ?? idx}
            className={cn(
              "px-3 py-2 flex items-center gap-2 hover:bg-muted/50",
              a.id && activeId === a.id && "bg-muted"
            )}
          >
            <div className="flex-1 cursor-pointer" onClick={() => a.id && onSelect?.(a.id)}>
              <div className="text-sm font-medium truncate">{a.body?.text ?? "(no text)"}</div>
              <div className="text-xs text-muted-foreground">
                {a.body?.display_name ?? "Unknown"}
                {a.body?.time_of_day ? ` • ${a.body.time_of_day}` : ""}
              </div>
              <div className="text-xs text-muted-foreground">
                <select
                  className="border rounded px-1 py-0.5 text-xs"
                  value={a.status ?? "todo"}
                  disabled={updating === a.id}
                  onChange={e => a.id && handleStatusChange(a.id, e.target.value)}
                  style={{ minWidth: 110 }}
                >
                  {STATUS_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {updating === a.id && <span className="ml-2 text-xs text-muted-foreground">Saving…</span>}
              </div>
              {a.url && (
                <div className="text-xs mt-1">
                  <button
                    type="button"
                    className="text-blue-600 underline break-all"
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
                    onClick={e => {
                      e.stopPropagation();
                      onNavigateToUrl?.(a.url!);
                    }}
                  >
                    {a.url}
                  </button>
                  {isCurrent && (
                    <span className="ml-2 px-2 py-0.5 rounded bg-green-100 text-green-800 text-xs">
                      Current page
                    </span>
                  )}
                </div>
              )}
            </div>
            {a.id && (
              <Button
                variant="destructive"
                size="sm"
                disabled={deleting === a.id}
                onClick={() => handleDelete(a.id)}
              >
                {deleting === a.id ? "Deleting..." : "Delete"}
              </Button>
            )}
          </div>
        );
      })}
      {safeItems.length === 0 && (
        <div className="p-4 text-sm text-muted-foreground">No annotations yet.</div>
      )}
    </div>
  );
}
