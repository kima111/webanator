"use client";
import { cn } from "@/lib/utils";
// removed external type import; use a minimal local type instead
type Ann = {
  id?: string;
  body?: { text?: string } | null;
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

  return (
    <div className="overflow-auto h-full divide-y">
      {safeItems.map((a, idx) => (
        <div
          key={a.id ?? idx}
          className={cn(
            "px-3 py-2 cursor-pointer hover:bg-muted/50",
            a.id && activeId === a.id && "bg-muted"
          )}
          onClick={() => a.id && onSelect?.(a.id)}
        >
          <div className="text-sm font-medium truncate">{a.body?.text ?? "(no text)"}</div>
          <div className="text-xs text-muted-foreground">{a.status ?? ""}</div>
        </div>
      ))}
      {safeItems.length === 0 && (
        <div className="p-4 text-sm text-muted-foreground">No annotations yet.</div>
      )}
    </div>
  );
}
