import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Expect query: project=<projectId>
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("project");
  if (!projectId) return NextResponse.json({ error: "missing project" }, { status: 400 });
  const { path } = await params;
  const objectPath = (path || []).join("/");
  try {
    // Auth user
    const supa = await createClient();
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // Membership check (owner/editor/viewer all allowed)
    const admin = createAdminClient();
    const { data: mem, error: memErr } = await admin
      .from("project_members")
      .select("project_id")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 });
    if (!mem) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    // Download from private bucket
    const { data: file, error: dlErr } = await admin.storage.from("uploads").download(objectPath);
    if (dlErr || !file) return NextResponse.json({ error: dlErr?.message || "not found" }, { status: 404 });

    const buff = Buffer.from(await file.arrayBuffer());
    // Basic content type inference
    const ct = file.type || inferType(objectPath) || "application/octet-stream";
    return new NextResponse(buff, { headers: { "content-type": ct, "cache-control": "private, max-age=60" } });
  } catch (e: unknown) {
    const message = ((): string => {
      if (e instanceof Error) return e.message;
      if (e && typeof e === "object" && "toString" in e) return String(e);
      try { return JSON.stringify(e); } catch { return "error"; }
    })();
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function inferType(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
  }
  return undefined;
}
