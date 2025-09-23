import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function DELETE(_req: Request, context: any) {
  const params = await context.params;
  const { id } = params;
  const supa = await createClient();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supa.from("annotations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function PATCH(req: Request, context: any) {
  const params = await context.params;
  const { id } = params;
  const body = await req.json();
  const supa = await createClient();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Allow updating status and/or assigned_to
  const { status, assigned_to } = body as { status?: string; assigned_to?: string | null };
  if (typeof status === "undefined" && typeof assigned_to === "undefined") {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  const patch: Record<string, unknown> = {};
  if (typeof status !== "undefined") patch.status = status;
  if (typeof assigned_to !== "undefined") {
    patch.assigned_to = assigned_to;
    patch["assigned_at"] = assigned_to ? new Date().toISOString() : null;
  }

  const { data, error } = await supa
    .from("annotations")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ annotation: data });
}
