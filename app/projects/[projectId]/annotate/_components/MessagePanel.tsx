"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AnnotationMessage } from "@/lib/types/annotations";

export default function MessagePanel({
  annotationId,
  messages,
  onSend,
}: {
  annotationId: string | null;
  messages: AnnotationMessage[]; // <-- allow author_id: string | null
  onSend: (annotationId: string, body: string) => Promise<void>;
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
        {messages.map((m) => (
          <div key={m.id} className="text-sm p-2 rounded-md border">
            <div className="text-xs text-muted-foreground mb-1">
              {new Date(m.created_at).toLocaleString()}
            </div>
            {/* Optional: show author when available */}
            {/* <div className="text-xs text-muted-foreground">
              {m.author_id ?? "Unknown"}
            </div> */}
            <div>{m.body}</div>
          </div>
        ))}
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
