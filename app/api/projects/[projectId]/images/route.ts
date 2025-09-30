import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

type Ctx = { params: Promise<{ projectId: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const supa = await createClient();
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // membership check
    const admin = createAdminClient();
    const { data: mem, error: memErr } = await admin
      .from("project_members")
      .select("project_id")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (memErr || !mem) return NextResponse.json({ images: [] }, { status: 200 });

    // list storage objects via Storage API under the project folder
    const folder = `project-${projectId}`;
    const { data: list, error } = await admin.storage.from("uploads").list(folder, {
      limit: 1000,
      sortBy: { column: "created_at", order: "desc" },
    });
    if (error) {
      console.error("[images GET] storage.list error", error);
      return NextResponse.json({ images: [] }, { status: 200 });
    }
    const images = (list || [])
      .filter((f) => !f.name.endsWith("/"))
      .map((f) => {
        const key = `${folder}/${f.name}`;
        const safe = key.split("/").map(encodeURIComponent).join("/");
        const url = `/api/storage/image/${safe}?project=${encodeURIComponent(projectId)}`;
        return { path: key, url };
      });
    return NextResponse.json({ images });
  } catch {
    return NextResponse.json({ images: [] }, { status: 200 });
  }
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const supa = await createClient();
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // membership check
  const admin = createAdminClient();
  const { data: mem } = await admin
      .from("project_members")
      .select("project_id")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!mem) {
      console.error("[images POST] forbidden: user not a member", { projectId, userId: user.id });
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (!files.length) return NextResponse.json({ error: "no files" }, { status: 400 });

    // Ensure uploads bucket exists (idempotent)
    try {
      const { data: bucketInfo } = await admin.storage.getBucket("uploads");
      if (!bucketInfo) {
        await admin.storage.createBucket("uploads", { public: false, fileSizeLimit: null });
      }
    } catch {
      // ignore; service role usually can create or bucket already exists
    }

    const uploaded: Array<{ path: string; url: string }> = [];
    for (const file of files) {
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `project-${projectId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: upErr } = await admin.storage.from("uploads").upload(path, file, {
        upsert: true,
        contentType: file.type || undefined,
        cacheControl: "60",
        metadata: { project_id: projectId },
      });
      if (upErr) {
        console.error("[images POST] upload failed", { path, name: file.name, type: file.type, upErr });
        continue;
      }
      const safe = path.split("/").map(encodeURIComponent).join("/");
      const url = `/api/storage/image/${safe}?project=${encodeURIComponent(projectId)}`;
      uploaded.push({ path, url });
    }

    if (!uploaded.length) {
      return NextResponse.json({ error: "no_uploads", message: "All uploads failed or were filtered.", count: files.length }, { status: 500 });
    }
    return NextResponse.json({ images: uploaded }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "upload_failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}