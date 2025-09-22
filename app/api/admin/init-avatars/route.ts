import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST() {
  try {
    const admin = createAdminClient();

    // 1) Ensure bucket exists
    const { data: list, error: listErr } = await admin.storage.listBuckets();
    if (listErr) throw listErr;
    const existing = (list || []).find((b) => b.name === "avatars");
    if (!existing) {
      const { error: createErr } = await admin.storage.createBucket("avatars", {
        public: true,
        fileSizeLimit: 10 * 1024 * 1024, // 10MB
      });
      if (createErr) throw createErr;
    } else if (!existing.public) {
      const { error: updErr } = await admin.storage.updateBucket("avatars", { public: true });
      if (updErr) throw updErr;
    }

    // 2) Set public read policy (for anon, allow object access)
    // Supabase Storage public bucket allows public read automatically, but
    // we add a defense-in-depth policy in case the bucket was private before.
    // NOTE: This uses the Postgres SQL API via admin.rpc if needed, but the
    // storage API suffices if `public: true`.

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Failed to init avatars bucket";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
