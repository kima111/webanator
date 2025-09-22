import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type RouteParams = { params: { id: string } };

// --- helpers: unwrap /api/proxy?url=..., strip hash, normalize path ---
function toAbs(href: string, baseHref: string) {
  try {
    return new URL(href, baseHref).toString();
  } catch {
    return href;
  }
}
function extractExternalUrl(rawUrl: string, reqUrl: string) {
  const abs = toAbs(rawUrl, reqUrl);
  try {
    const reqOrigin = new URL(reqUrl).origin;
    const u = new URL(abs);
    let target = u;
    // If pointing at our own proxy, unwrap ?url=
    if (u.origin === reqOrigin && u.pathname.startsWith("/api/proxy")) {
      const inner = u.searchParams.get("url");
      if (inner) target = new URL(inner);
    }
    // Drop fragment/hash while keeping query
    target.hash = "";
    // Normalize trailing slash (but keep domain root slash)
    if (target.pathname !== "/" && target.pathname.endsWith("/")) {
      target.pathname = target.pathname.replace(/\/+$/, "");
    }
    return target.toString();
  } catch {
    return abs.split("#")[0]; // best-effort
  }
}

// Safe helper to read a PostgREST-style error code without using any
function getErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export async function PATCH(req: NextRequest, context: unknown) {
  const { id } = (context as RouteParams).params;
  const supa = await createClient();
  const user = (await supa.auth.getUser())?.data?.user;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  body.updated_at = new Date().toISOString();

  const { data, error } = await supa
    .from("annotations")
    .update(body)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ annotation: data });
}

type Ctx = { params: { id: string } };
export async function DELETE(_req: Request, context: unknown) {
  const { id } = (context as Ctx).params;
  const supa = await createClient();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supa.from("annotations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    const rawUrl = searchParams.get("url") ?? undefined;

    if (!projectId) {
      return NextResponse.json({ annotations: [] }, { status: 200 });
    }

    const supabase = await createClient();

    let query = supabase
      .from("annotations")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    if (rawUrl) {
      // Build candidates: normalized external URL + raw (for leniency)
      const normalized = extractExternalUrl(rawUrl, req.url);
      const candidates = Array.from(new Set([normalized, rawUrl].filter(Boolean))) as string[];
      query = query.in("url", candidates);
    }

    const { data, error } = await query;

    if (error) {
      const code = getErrorCode(error);
      if (code === "42P01" || code === "42501") {
        console.warn("GET /api/annotations handled error:", code, (error as { message?: string }).message);
        return NextResponse.json({ annotations: [] }, { status: 200 });
      }
      console.error("GET /api/annotations unexpected error:", (error as { message?: string }).message ?? String(error));
      return NextResponse.json({ annotations: [] }, { status: 200 });
    }

    return NextResponse.json({ annotations: data ?? [] }, { status: 200 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("GET /api/annotations exception:", msg);
    return NextResponse.json({ annotations: [] }, { status: 200 });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const payload = await req.json().catch(() => ({}));
    const { project_id, url, selector, body, status } = payload ?? {};
    if (!project_id || !url) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    // Normalize to the external page URL so GET matches immediately
    const normalizedUrl = extractExternalUrl(url, req.url);

    // Accept either a CSS selector or a point anchor; build a fallback selector if needed
    let finalSelector = selector;
    if (!finalSelector?.type || !finalSelector?.value) {
      const anchor = body?.anchor;
      if (anchor && typeof anchor.x === "number" && typeof anchor.y === "number") {
        finalSelector = { type: "point", value: JSON.stringify(anchor) };
      }
    }
    if (!finalSelector?.type || !finalSelector?.value) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    // --- Add display name and time of day to annotation body ---
    const now = new Date();
    const timeOfDay = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    // Try to use username, fallback to first/last name, fallback to email
    const meta = (user.user_metadata || {}) as Partial<{
      username: string;
      first_name: string;
      last_name: string;
      avatar_url: string;
    }>;
    const displayName =
      meta.username ||
      [meta.first_name, meta.last_name].filter(Boolean).join(" ") ||
      user.email ||
      "Unknown";

    const nameSeed = displayName;
  const avatarFromMeta = typeof meta.avatar_url === "string" && meta.avatar_url.length > 0 ? meta.avatar_url : undefined;
    const authorAvatarUrl = avatarFromMeta || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(nameSeed)}`;

    const annotationBody = {
      ...body,
      display_name: displayName,
      time_of_day: timeOfDay,
      author_avatar_url: authorAvatarUrl,
    };

    const { data, error } = await supabase
      .from("annotations")
      .insert([
        {
          project_id,
          url: normalizedUrl,
          selector: finalSelector,
          body: annotationBody,
          status: status ?? "open",
          created_by: user.id,
        },
      ])
      .select("id")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ id: data?.id }, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
