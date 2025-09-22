"use client";
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import NextImage from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AnnotationMessage } from "@/lib/types/annotations";

export default function MessagePanel({
  annotationId,
  messages,
  onSend,
  onDelete,
}: {
  annotationId: string | null;
  messages: AnnotationMessage[]; // <-- allow author_id: string | null
  onSend: (annotationId: string, body: string) => Promise<void>;
  onDelete?: (annotationId: string, messageId: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, annotationId]);

  if (!annotationId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Select an annotation to view messages.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
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
                  <div>{m.body}</div>
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
