"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import type { Annotation, AnnotationMessage } from "@/lib/types/annotations";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

export function useAnnotationRealtime(projectId: string, url?: string) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);

  const fetchAll = useCallback(async () => {
    const qs = new URLSearchParams({ projectId, ...(url ? { url } : {}) }).toString();
    const res = await fetch(`/api/annotations?${qs}`, { credentials: "include" });

    if (!res.ok) {
      console.error("annotations fetch failed", res.status, res.statusText);
      setAnnotations([]);
      return;
    }

    let data: { annotations?: Annotation[] } = {};
    try {
      // Handle empty body or non-JSON gracefully
      const text = await res.text();
      if (text) {
        data = JSON.parse(text);
      }
    } catch (e) {
      console.error("annotations parse failed", e);
    }

    setAnnotations(data.annotations ?? []);
  }, [projectId, url]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // --- Realtime subscription ---
  useEffect(() => {
    if (!supabaseRef.current) supabaseRef.current = createClient();
    const supabase = supabaseRef.current;

    // Tear down any existing
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const channel = supabase
      .channel("annotations:project")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "annotations",
        },
        (payload) => {
          const newRow = (payload as { new?: { project_id?: string } }).new;
          const oldRow = (payload as { old?: { project_id?: string } }).old;
          const pid = newRow?.project_id || oldRow?.project_id;
          if (!pid || pid === projectId) {
            console.log("Supabase Realtime event (annotations):", payload);
            fetchAll();
          }
        }
      )
      // Broadcast fallback for inserts from clients
      .on(
        "broadcast",
        { event: "annotation_created" },
        (p: { payload?: { project_id?: string } }) => {
          const pid = p?.payload?.project_id;
          if (!pid || pid === projectId) {
            console.log("Broadcast event (annotation_created)", p);
            fetchAll();
          }
        }
      )
      .subscribe((status) => {
        console.log("Supabase channel (annotations) status:", status);
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [fetchAll, projectId]);

  // keep signature stable with previous usage
  const announceCreated = useCallback(() => {
    try {
      channelRef.current?.send({ type: "broadcast", event: "annotation_created", payload: { project_id: projectId } });
    } catch {}
  }, [projectId]);

  return { annotations, createAnnotation: fetchAll, announceCreated };
}

// Make messages realtime per-annotation
export function useMessagesRealtime() {
  const [messages, setMessages] = useState<AnnotationMessage[]>([]);
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);

  function dedupeById(list: AnnotationMessage[]): AnnotationMessage[] {
    const seen = new Set<string>();
    const out: AnnotationMessage[] = [];
    for (const m of list) {
      const id = m.id;
      if (typeof id !== "string") continue;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(m);
      }
    }
    return out;
  }

  const subscribeTo = useCallback(async (annotationId: string) => {
    // initial fetch
    const res = await fetch(`/api/annotations/${annotationId}/messages`, { credentials: "include" });
  const data = (await res.json()) as { messages: AnnotationMessage[] };
  setMessages(dedupeById(data.messages ?? []));

    if (!supabaseRef.current) supabaseRef.current = createClient();
    const supabase = supabaseRef.current;

    // tear down previous channel
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    // subscribe to postgres changes + broadcast fallback
    const channel = supabase
      .channel(`annotation_messages:${annotationId}`);

    channel
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "annotation_messages", filter: `annotation_id=eq.${annotationId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            // Refetch to include enriched author fields
            void fetch(`/api/annotations/${annotationId}/messages`, { credentials: "include" })
              .then((r) => r.json())
              .then((d) => setMessages(dedupeById(d.messages ?? [])))
              .catch(() => {});
          } else if (payload.eventType === "DELETE") {
            const id = (payload.old as AnnotationMessage | null)?.id;
            if (id) setMessages((prev) => prev.filter((m) => m.id !== id));
            else {
              // Fallback: refetch if old row not present
              void fetch(`/api/annotations/${annotationId}/messages`, { credentials: "include" })
                .then((r) => r.json())
                .then((d) => setMessages(dedupeById(d.messages ?? [])))
                .catch(() => {});
            }
          } else {
            // UPDATE or unknown -> refetch
            void fetch(`/api/annotations/${annotationId}/messages`, { credentials: "include" })
              .then((r) => r.json())
              .then((d) => setMessages(dedupeById(d.messages ?? [])))
              .catch(() => {});
          }
        }
      );

    // Add broadcast listener with a typed cast to satisfy types without using any
    (channel as unknown as {
      on: (
        type: "broadcast",
        filter: { event: string },
        cb: (payload: { payload?: { id?: string } }) => void
      ) => RealtimeChannel;
    }).on("broadcast", { event: "message_deleted" }, (payload) => {
      const id = payload?.payload?.id;
      if (id) setMessages((prev) => prev.filter((m) => m.id !== id));
    });

    channel.subscribe((status) => {
      console.log(`Supabase channel (annotation_messages:${annotationId}) status:`, status);
    });

    channelRef.current = channel;
  }, []);

  useEffect(() => {
    return () => {
      const supabase = supabaseRef.current;
      if (supabase && channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, []);

  const sendMessage = useCallback(async (annotationId: string, body: string) => {
    await fetch(`/api/annotations/${annotationId}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    // Do not optimistically append to avoid race with realtime INSERT
    // Rely on realtime INSERT or a quick refetch (handled on channel events)
  }, []);

  const deleteMessage = useCallback(async (annotationId: string, messageId: string) => {
    await fetch(`/api/annotations/${annotationId}/messages?messageId=${encodeURIComponent(messageId)}`, {
      method: "DELETE",
      credentials: "include",
    });
    // Local optimistic removal (sender UX)
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    // Broadcast so other clients update even if Postgres DELETE isn’t delivered
    try {
      channelRef.current?.send({ type: "broadcast", event: "message_deleted", payload: { id: messageId } });
    } catch {}
  }, []);

  return { messages, sendMessage, subscribeTo, deleteMessage };
}
