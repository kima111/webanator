"use client";
import { useState, useEffect, useCallback } from "react";
import type { Annotation, AnnotationMessage } from "@/lib/types/annotations";

export function useAnnotationRealtime(projectId: string, url?: string) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

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

  // keep signature stable with previous usage
  return { annotations, createAnnotation: fetchAll };
}

export function useMessagesRealtime() {
  const [messages, setMessages] = useState<AnnotationMessage[]>([]);

  const subscribeTo = useCallback(async (annotationId: string) => {
    const res = await fetch(`/api/annotations/${annotationId}/messages`, { credentials: "include" });
    const data = (await res.json()) as { messages: AnnotationMessage[] };
    setMessages(data.messages ?? []);
  }, []);

  const sendMessage = useCallback(async (annotationId: string, body: string) => {
    await fetch(`/api/annotations/${annotationId}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }, []);

  return { messages, sendMessage, subscribeTo };
}
