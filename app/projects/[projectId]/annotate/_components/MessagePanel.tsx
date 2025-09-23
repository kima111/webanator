"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Skeleton } from "@/components/ui/skeleton";
import NextImage from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Annotation, AnnotationMessage } from "@/lib/types/annotations";

export default function MessagePanel({
  annotationId,
  messages,
  onSend,
  onDelete,
  activeAnnotation,
}: {
  annotationId: string | null;
  messages: AnnotationMessage[]; // <-- allow author_id: string | null
  onSend: (annotationId: string, body: string) => Promise<void>;
  onDelete?: (annotationId: string, messageId: string) => Promise<void>;
  activeAnnotation?: Annotation | null;
}) {
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = (id: string) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, annotationId]);

  // Fetch project members to render assignee info for the active annotation
  const [members, setMembers] = useState<Record<string, { label: string; avatar_url?: string | null }>>({});
  const projectId = activeAnnotation?.project_id;
  const assigneeId = activeAnnotation?.assigned_to || null;
  useEffect(() => {
    (async () => {
      if (!projectId) return;
      try {
        const res = await fetch(`/api/projects/${projectId}/members`, { cache: "no-store" });
        const out = await res.json();
        const list: Array<{ user_id: string; email?: string | null; username?: string | null; first_name?: string | null; last_name?: string | null; avatar_url?: string | null }> = out?.members || [];
        const map: Record<string, { label: string; avatar_url?: string | null }> = {};
        for (const m of list) {
          const label = m.username || [m.first_name, m.last_name].filter(Boolean).join(" ") || m.email || m.user_id;
          map[m.user_id] = { label, avatar_url: m.avatar_url ?? null };
        }
        setMembers(map);
      } catch {
        setMembers({});
      }
    })();
  }, [projectId]);

  const assignee = useMemo(() => {
    if (!assigneeId) return null;
    const info = members[assigneeId];
    if (info) return info;
    return { label: assigneeId.slice(0, 8), avatar_url: null };
  }, [assigneeId, members]);

  if (!annotationId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Select an annotation to view messages.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {activeAnnotation && assigneeId && assignee && (
        <div className="px-3 py-2 border-b flex items-center gap-2 text-xs text-muted-foreground">
          <img
            src={assignee.avatar_url || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(assignee.label)}`}
            alt={assignee.label}
            className="h-4 w-4 rounded-full border object-cover"
          />
          <span>Assigned to {assignee.label}</span>
        </div>
      )}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {messages.map((m) => {
          const display = m.author_display_name || m.author_email || m.author_id || "Unknown";
          const avatar = m.author_avatar_url || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(display)}`;
          const avatarLoaded = Boolean(m.author_avatar_url);
          return (
            <div key={m.id} className="text-sm p-2 rounded-md border flex items-center justify-between gap-2">
              <div className="flex items-start gap-3">
                {avatarLoaded ? (
                  <NextImage src={avatar} alt={display} width={24} height={24} unoptimized className="h-6 w-6 rounded-full border object-cover mt-0.5" />
                ) : (
                  <Skeleton className="h-6 w-6 rounded-full mt-0.5" />
                )}
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {new Date(m.created_at).toLocaleString()}
                  </div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {display}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm leading-5">
                    {(() => {
                      const full = m.body || "";
                      const isExpanded = typeof m.id === "string" && expanded[m.id];
                      const text = isExpanded ? full : (full.length > 400 ? full.slice(0, 400) + "…" : full);
                      return (
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                          {text}
                        </ReactMarkdown>
                      );
                    })()}
                    {(m.body?.length || 0) > 400 && typeof m.id === "string" && (
                      <button
                        type="button"
                        className="mt-1 text-xs text-blue-600 underline"
                        onClick={() => toggleExpanded(m.id as string)}
                      >
                        {expanded[m.id as string] ? "Show less" : "Show more"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  if (typeof m.id === "string" && annotationId && typeof onDelete === "function") {
                    await onDelete(annotationId, m.id);
                  }
                }}
              >
                Delete
              </Button>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <div className="border-t p-3 flex items-center gap-2">
        <Input
          placeholder="Message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === "Enter" && text.trim()) {
              await onSend(annotationId, text.trim());
              setText("");
            }
          }}
        />
        <Button
          onClick={async () => {
            if (!text.trim()) return;
            await onSend(annotationId, text.trim());
            setText("");
          }}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
