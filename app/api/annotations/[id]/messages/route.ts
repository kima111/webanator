import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
  // Enrich author fields
  const admin = createAdminClient();
  const uniqueIds = Array.from(new Set((data ?? []).map((m) => m.author_id).filter(Boolean) as string[]));
  const map: Record<string, { email: string | null; display: string | null; avatar: string | null }> = {};
  await Promise.all(
    uniqueIds.map(async (uid) => {
      try {
        const { data: u, error: e } = await admin.auth.admin.getUserById(uid);
        if (e || !u?.user) return;
        const meta = (u.user.user_metadata ?? {}) as Record<string, unknown>;
        const first = typeof meta.first_name === "string" ? (meta.first_name as string) : "";
        const last = typeof meta.last_name === "string" ? (meta.last_name as string) : "";
        const username = typeof meta.username === "string" ? (meta.username as string) : "";
        const display = username || [first, last].filter(Boolean).join(" ") || u.user.email || null;
        const avatar = typeof meta.avatar_url === "string" ? (meta.avatar_url as string) : null;
        map[uid] = { email: u.user.email ?? null, display, avatar };
      } catch {}
    })
  );

  const messages = (data ?? []).map((msg) => {
    const uid = msg.author_id ?? undefined;
    const info = uid ? map[uid] : undefined;
    const displayName = info?.display ?? null;
    const email = info?.email ?? null;
    const avatar = info?.avatar ?? null;
    return {
      ...msg,
      author_email: email,
      author_display_name: displayName,
      author_avatar_url: avatar ?? (displayName ? `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(displayName)}` : null),
    };
  });
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
