import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, context: Ctx) {
  const { projectId } = await context.params;
  try {
    const supa = await createClient();
    const {
      data: { user },
    } = await supa.auth.getUser();
    if (!user) return NextResponse.json({ members: [] }, { status: 401 });

    // Ensure requester is a member
    // Determine role: either explicit member role or implicit owner role
    const { data: me } = await supa
      .from("project_members")
      .select("project_id, role")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();

    let me_role: "viewer" | "editor" | "owner" | null = me?.role ?? null;
    if (!me_role) {
      const { data: proj } = await supa
        .from("projects")
        .select("id, owner_id")
        .eq("id", projectId)
        .maybeSingle();
      if (proj && proj.owner_id === user.id) {
        me_role = "owner";
      }
    }
    if (!me_role) return NextResponse.json({ members: [], me_role: null }, { status: 403 });

    const { data, error } = await supa
      .from("project_members")
      .select("project_id, user_id, role, joined_at")
      .eq("project_id", projectId);
    if (error) return NextResponse.json({ members: [] }, { status: 200 });

    // Enrich with basic profile info via admin to get avatar/email
    const admin = createAdminClient();
    const members = await Promise.all(
      (data ?? []).map(async (m) => {
        try {
          const { data: u } = await admin.auth.admin.getUserById(m.user_id);
          const user = u?.user;
          const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
          const avatar_url = typeof meta["avatar_url"] === "string" ? (meta["avatar_url"] as string) : null;
          const first_name = typeof meta["first_name"] === "string" ? (meta["first_name"] as string) : null;
          const last_name = typeof meta["last_name"] === "string" ? (meta["last_name"] as string) : null;
          const username = typeof meta["username"] === "string" ? (meta["username"] as string) : null;
          return {
            project_id: m.project_id,
            user_id: m.user_id,
            role: m.role,
            joined_at: m.joined_at,
            email: user?.email ?? null,
            avatar_url,
            first_name,
            last_name,
            username,
          };
        } catch {
          return { ...m, email: null, avatar_url: null };
        }
      })
    );

  return NextResponse.json({ members, me_role }, { status: 200 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ members: [], me_role: null, error: msg }, { status: 200 });
  }
}
