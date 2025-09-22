import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const ids: unknown = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ users: [] }, { status: 200 });
    }
    const uniqueIds = Array.from(new Set(ids.filter((v) => typeof v === "string"))) as string[];
    const limit = Math.min(uniqueIds.length, 50);
    const idsToFetch = uniqueIds.slice(0, limit);

    const admin = createAdminClient();
    const results = await Promise.all(
      idsToFetch.map(async (id) => {
        try {
          const { data, error } = await admin.auth.admin.getUserById(id);
          if (error || !data?.user) return null;
          const u = data.user;
          const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
          const avatar_url = typeof meta.avatar_url === "string" ? (meta.avatar_url as string) : null;
          const first_name = typeof meta.first_name === "string" ? (meta.first_name as string) : null;
          const last_name = typeof meta.last_name === "string" ? (meta.last_name as string) : null;
          const username = typeof meta.username === "string" ? (meta.username as string) : null;
          return { id: u.id, email: u.email, avatar_url, first_name, last_name, username };
        } catch {
          return null;
        }
      })
    );

    const users = results.filter(Boolean);
    return NextResponse.json({ users }, { status: 200 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: msg, users: [] }, { status: 200 });
  }
}
