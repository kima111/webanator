"use client";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { Button } from "@/components/ui/button";
// removed external type import; use a minimal local type instead
type Ann = {
  id?: string;
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
}: {
  items?: Ann[] | null;
  activeId: string | null;
  onSelect?: (id: string) => void;
}) {
  const safeItems = Array.isArray(items) ? items : [];
  const [deleting, setDeleting] = useState<string | null>(null);

  async function handleDelete(id?: string) {
    if (!id) return;
    setDeleting(id);
    await fetch(`/api/annotations/${id}`, { method: "DELETE" });
    setDeleting(null);
    window.location.reload(); // quick refresh, or lift state to parent for better UX
  }

  return (
    <div className="overflow-auto h-full divide-y">
      {safeItems.map((a, idx) => (
        <div
          key={a.id ?? idx}
          className={cn(
            "px-3 py-2 flex items-center gap-2 hover:bg-muted/50",
            a.id && activeId === a.id && "bg-muted"
          )}
        >
          <div
            className="flex-1 cursor-pointer"
            onClick={() => a.id && onSelect?.(a.id)}
          >
            <div className="text-sm font-medium truncate">{a.body?.text ?? "(no text)"}</div>
            <div className="text-xs text-muted-foreground">
              {a.body?.display_name ?? "Unknown"}
              {a.body?.time_of_day ? ` • ${a.body.time_of_day}` : ""}
            </div>
            <div className="text-xs text-muted-foreground">{a.status ?? ""}</div>
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
      ))}
      {safeItems.length === 0 && (
        <div className="p-4 text-sm text-muted-foreground">No annotations yet.</div>
      )}
    </div>
  );
}
