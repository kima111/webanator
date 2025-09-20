import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Ctx = { params: { id: string } }; // local helper for our casts

export async function DELETE(_req: Request, context: unknown) {
  const { id } = await (context as Ctx).params;
  const url = new URL(_req.url);
  const messageId = url.searchParams.get("messageId");
  if (!messageId) return NextResponse.json({ error: "Missing messageId" }, { status: 400 });

  const supa = await createClient();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rely on RLS to authorize (editors/owners or author). Do not restrict to author here.
  const { error } = await supa
    .from("annotation_messages")
    .delete()
    .eq("id", messageId)
    .eq("annotation_id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}

export async function GET(_req: Request, context: unknown) {
  const { id } = await (context as Ctx).params;

  const supa = await createClient();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supa
      .from("annotation_messages")
      .select("*")
      .eq("annotation_id", id)
      .order("created_at");

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  // Flatten author info into each message as author_email
    type MessageWithAuthor = Partial<import("@/lib/types/annotations").AnnotationMessage> & { author?: { id: string; email: string } };
  const messages = (data ?? []).map((msg: MessageWithAuthor) => ({
    ...msg,
    author_email: msg.author?.email ?? null,
  }));
  return NextResponse.json({ messages });
}

export async function POST(req: Request, context: unknown) {
  const { id } = await (context as Ctx).params;

  const supa = await createClient();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { body } = await req.json();

  const { data, error } = await supa
    .from("annotation_messages")
    .insert({ annotation_id: id, author_id: user.id, body })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ message: data }, { status: 201 });
}
