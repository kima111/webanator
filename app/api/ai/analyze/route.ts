import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "AI disabled (missing OPENAI_API_KEY)" }, { status: 501 });
    }
    const body = await req.json().catch(() => ({}));
    const { url, selector, context } = body ?? {};
    if (!url || !context?.html) {
      return NextResponse.json({ error: "Missing url/context" }, { status: 400 });
    }

    const html = String(context.html).slice(0, 6000);
    const text = String(context.text ?? "").slice(0, 2000);
    const role = String(context.role ?? "");
    const aria = String(context.aria ?? "");
    const bbox = context.bbox as { x: number; y: number; w: number; h: number } | undefined;

    const prompt = [
      `You are reviewing a webpage element for usability, accessibility, and clarity.`,
      `Page: ${url}`,
      selector ? `Selector: ${selector}` : `Selector: (none)`,
      role ? `Role: ${role}` : "",
      aria ? `ARIA: ${aria}` : "",
      bbox ? `Box: x=${bbox.x}, y=${bbox.y}, w=${bbox.w}, h=${bbox.h}` : "",
      `Visible text:\n${text || "(none)"}`,
      `Outer HTML (trimmed):\n${html}`,
      ``,
      `Give concise, actionable feedback (max ~6 bullet points):`,
      `- UX issues and suggestions`,
      `- Accessibility (labels, contrast, roles, semantics)`,
      `- Copy suggestions if applicable`,
      `- One-liner summary at the end`,
    ].filter(Boolean).join("\n");

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a senior UX reviewer and accessibility expert. Be brief and practical." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json({ error: err.error?.message ?? res.statusText }, { status: 400 });
    }
    const json = await res.json();
    const suggestion = json?.choices?.[0]?.message?.content?.trim?.() ?? "No suggestions.";
    return NextResponse.json({ suggestion }, { status: 200 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}