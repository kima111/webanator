import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Ctx = { params: { id: string } }; // local helper for our casts

export async function GET(_req: Request, context: unknown) {
  const { id } = (context as Ctx).params;

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
  return NextResponse.json({ messages: data });
}

export async function POST(req: Request, context: unknown) {
  const { id } = (context as Ctx).params;

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
