// app/protected/page.tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import MembersDialog from "@/components/members-dialog";
import { createAdminClient } from "@/lib/supabase/admin";
import { NewProjectChooser } from "./_components/NewProjectChooser";
import { revalidatePath } from "next/cache";
import type { User } from "@supabase/supabase-js";
import Link from "next/link";

// --- Local cache for user email + confirmation
type CachedUser = { email: string | null; email_confirmed: boolean; ts: number };
const USER_CACHE_TTL_MS = 60_000;
const userCache = new Map<string, CachedUser>();

// // --- Schema-aligned types
// type _Project = never;

type Membership = {
  project_id: string;
  user_id: string;
  role: "owner" | "editor" | "viewer" | null;
  created_at?: string | null;
};

// --- Helpers

export default async function ProtectedPage() {
  const supabase = await createClient();

  const { data: claimsData, error: claimsErr } = await supabase.auth.getClaims();
  if (claimsErr || !claimsData?.claims) {
    redirect("/auth/login");
  }

  // let _currentUserId: string | undefined;
  // try {
  //   const { data: userResp } = await supabase.auth.getUser();
  //   _currentUserId = userResp?.user?.id ?? undefined;
  // } catch (e) {
  //   console.error("auth.getUser failed", e);
  // }

  // Removed legacy "create project by URL" action in favor of NewProjectChooser

  async function createNewProject(formData: FormData) {
    "use server";
    const kind = String(formData.get("type") || "");
    const rawName = (formData.get("project_name") || "").toString().trim();
    const rawUrl = (formData.get("url") || "").toString().trim();
    const file = formData.get("image_file") as File | null;

    const s = await createClient();
    const { data: { user } } = await s.auth.getUser();
    if (!user) throw new Error("Not authenticated");
    const id = crypto.randomUUID();
    const admin = createAdminClient();
    let origin = "";
    let finalName = rawName || "Project";

    if (kind === "website") {
      if (!rawUrl) throw new Error("Missing URL");
      let parsed: URL;
      try { parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`); } catch { throw new Error("Invalid URL"); }
      origin = parsed.toString();
      if (!rawName) finalName = parsed.hostname.slice(0, 120);
    } else if (kind === "image") {
      if (!file) throw new Error("Missing image file");
      const ext = file.name.split(".").pop() || "png";
      const objectPath = `project-${id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      console.log("[createNewProject] Upload start", { path: objectPath, fileName: file.name, size: file.size, type: file.type });
      const { error: upErr } = await admin.storage.from("uploads").upload(objectPath, file, {
        upsert: true,
        contentType: file.type,
        cacheControl: "3600",
        metadata: { project_id: id },
      });
      if (upErr) { console.error("[createNewProject] Upload error", upErr); throw upErr; }
      // Store proxy-based origin referencing internal secured endpoint
      const proxyUrl = `/api/storage/image/${objectPath}?project=${id}`;
      origin = `/image-viewer?src=${encodeURIComponent(proxyUrl)}`;
      console.log("[createNewProject] Computed origin", { origin, proxyUrl });
      if (!rawName) finalName = file.name.slice(0, 120);
    } else {
      throw new Error("Unknown project type");
    }

    const { error: insErr } = await s.from("projects").insert({ id, owner_id: user.id, name: finalName, origin });
    if (insErr) throw insErr;

    const { error: memErr } = await admin.from("project_members").upsert(
      { project_id: id, user_id: user.id, role: "owner", joined_at: new Date().toISOString() },
      { onConflict: "user_id,project_id" }
    );
    if (memErr) throw memErr;
    console.log("[createNewProject] Project inserted", { id, kind, origin });
    const encoded = encodeURIComponent(origin);
    console.log("[createNewProject] Redirecting to annotator", { encoded });
    redirect(`/projects/${id}/annotate?url=${encoded}`);
  }

  // Load projects
  const { data: projData, error: projError } = await supabase
    .from("projects")
    .select("id, name, origin, created_at")
    .order("created_at", { ascending: false });

  const projects =
    (projData ?? []) as { id: string; name: string | null; origin: string | null; created_at: string | null }[];

  // --- Load memberships for those projects (ADMIN bypass for richer UI)
  const projectIds = projects.map((p) => p.id).filter(Boolean);

  type EnrichedMembership = Membership & {
    email: string | null;
    email_confirmed: boolean;
  };

  let membersByProject = new Map<string, EnrichedMembership[]>();

  if (projectIds.length > 0) {
    const admin = createAdminClient();

    const { data: memData, error: memErr } = await admin
      .from("project_members")
      .select("*")
      .in("project_id", projectIds);

    if (memErr) {
      console.error("Failed to load memberships (admin)", memErr);
    }

    const basicMems: Membership[] = (memData as Membership[] | null) ?? [];

    // Fetch user emails once (cached)
    const uniqueUserIds = Array.from(new Set(basicMems.map((m) => m.user_id))).filter(Boolean);
    const userDetails = new Map<string, { email: string | null; email_confirmed: boolean }>();

    await Promise.all(
      uniqueUserIds.map(async (uid) => {
        const cached = userCache.get(uid);
        const now = Date.now();
        if (cached && now - cached.ts < USER_CACHE_TTL_MS) {
          userDetails.set(uid, { email: cached.email, email_confirmed: cached.email_confirmed });
          return;
        }
        try {
          const { data: userResp, error: userErr } = await admin.auth.admin.getUserById(uid);
          if (userErr) {
            console.error("getUserById error", uid, userErr);
            return;
          }
          const u = userResp?.user as User | null | undefined;
          const email = u?.email ?? null;
          const email_confirmed = Boolean(u?.email_confirmed_at ?? false);
          userDetails.set(uid, { email, email_confirmed });
          userCache.set(uid, { email, email_confirmed, ts: now });
        } catch (e) {
          console.error("getUserById threw", uid, e);
        }
      })
    );

    const enriched: EnrichedMembership[] = basicMems.map((m) => ({
      ...m,
      email: userDetails.get(m.user_id)?.email ?? null,
      email_confirmed: userDetails.get(m.user_id)?.email_confirmed ?? false,
    }));

    membersByProject = new Map<string, EnrichedMembership[]>();
    for (const m of enriched) {
      const arr = membersByProject.get(m.project_id) ?? [];
      arr.push(m);
      membersByProject.set(m.project_id, arr);
    }
  }

  async function deleteProject(formData: FormData) {
    "use server";
    const id = formData.get("id");
    if (!id || typeof id !== "string") return;

    const s = await createClient();
    const { error: delError } = await s.from("projects").delete().eq("id", id);
    if (delError) {
      console.error("Failed to delete project", delError);
    }
    revalidatePath("/protected");
  }

  async function inviteMemberByEmail(formData: FormData) {
    "use server";
    const projectId = formData.get("project_id");
    const email = formData.get("email");
    const roleRaw = formData.get("role");
    if (typeof projectId !== "string" || typeof email !== "string" || !projectId || !email) return;

    const allowedRoles = new Set(["viewer", "editor", "owner"]);
    const role =
      typeof roleRaw === "string" && allowedRoles.has(roleRaw)
        ? (roleRaw as "viewer" | "editor" | "owner")
        : undefined;

    const admin = createAdminClient();

    // AuthZ: only owners can invite/manage
    const sForAuth = await createClient();
    const { data: meResp, error: meErr } = await sForAuth.auth.getUser();
    if (meErr || !meResp?.user?.id) throw new Error("Not authenticated");
    const myId = meResp.user.id;

    const { data: myMem, error: myMemErr } = await admin
      .from("project_members")
      .select("role")
      .eq("project_id", projectId)
      .eq("user_id", myId)
      .maybeSingle();
    if (myMemErr || !myMem || myMem.role !== "owner") throw new Error("Only owners can add members");

    // Find or invite user by email
    const { data: userList, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (listErr) console.error("Admin listUsers error", listErr);

    let userId: string | undefined = userList?.users?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    )?.id;
    let userWasCreated = false;

    if (!userId) {
      const base = process.env.NEXT_PUBLIC_BASE_URL;
      const redirectTo = base ? `${base}/protected` : undefined;
      const { data: invite, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (inviteErr) {
        console.error("Admin invite error", inviteErr);
        return;
      }
      userId = invite.user?.id;
      userWasCreated = Boolean(userId);
    } else {
      try {
        const base = process.env.NEXT_PUBLIC_BASE_URL;
        const emailRedirectTo = base ? `${base}/protected` : undefined;
        const s = await createClient();
        await s.auth.signInWithOtp({ email, options: { emailRedirectTo } });
      } catch (e) {
        console.error("signInWithOtp error", e);
      }
    }

    if (!userId) {
      console.error("Could not resolve user id after invite");
      return;
    }

    // Upsert membership
    const payload: Record<string, unknown> = { project_id: projectId, user_id: userId };
    if (role) payload.role = role;

    const { error: upsertError } = await admin
      .from("project_members")
      .upsert(payload, { onConflict: "user_id,project_id" });
    if (upsertError) {
      console.error("Failed to add member by email", upsertError);
      throw new Error(`Membership upsert failed: ${upsertError.message}`);
    }

    // Optional: generate action link
    let actionLink: string | undefined;
    try {
      const base = process.env.NEXT_PUBLIC_BASE_URL;
      const nextPath = "/protected";
      const redirectTo = base ? `${base}${nextPath}` : undefined;
      const linkType = (userWasCreated ? "invite" : "magiclink") as "invite" | "magiclink";
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: linkType,
        email,
        options: { redirectTo },
      });
      if (linkErr) {
        console.error("generateLink error", linkErr);
      } else if (linkData) {
        type GeneratedLink = { action_link?: string; properties?: { action_link?: string } };
        const ld = linkData as unknown as GeneratedLink;
        actionLink = ld.action_link ?? ld.properties?.action_link;
      }
    } catch (e) {
      console.error("generateLink threw", e);
    }

    revalidatePath("/protected");
    if (!actionLink) throw new Error("No action link returned from Supabase");
    return actionLink;
  }

  async function removeMember(formData: FormData) {
    "use server";
    const projectId = formData.get("project_id");
    const userId = formData.get("member_user_id");
    if (typeof projectId !== "string" || typeof userId !== "string" || !projectId || !userId) return;

    const admin = createAdminClient();

    // AuthZ: only owners can remove members
    const sForAuth = await createClient();
    const { data: meResp, error: meErr } = await sForAuth.auth.getUser();
    if (meErr || !meResp?.user?.id) throw new Error("Not authenticated");
    const myId = meResp.user.id;

    const { data: myMem, error: myMemErr } = await admin
      .from("project_members")
      .select("role")
      .eq("project_id", projectId)
      .eq("user_id", myId)
      .maybeSingle();
    if (myMemErr || !myMem || myMem.role !== "owner") throw new Error("Only owners can remove members");

    const { error: rmError } = await admin
      .from("project_members")
      .delete()
      .eq("project_id", projectId)
      .eq("user_id", userId);
    if (rmError) console.error("Failed to remove member", rmError);

    revalidatePath("/protected");
  }

  return (
    <div className="flex-1 w-full flex flex-col gap-12">
      {/* <div className="w-full">
        <div className="bg-accent text-sm p-3 px-5 rounded-md text-foreground flex gap-3 items-center">
          <InfoIcon size="16" strokeWidth={2} />
          This is a protected page that you can only see as an authenticated user
        </div>
      </div> */}

      <NewProjectChooser action={createNewProject} />

      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2 items-start">
          <h2 className="font-bold text-2xl">Projects</h2>
          <p className="text-sm text-muted-foreground">
            Loaded from your projects <code>projects</code>.
          </p>
          <p className="text-xs text-muted-foreground">
            Tip: Open a project to launch the annotator. To place an annotation, hold <kbd className="px-1 py-0.5 border rounded">Shift</kbd> and click on the page.
          </p>
        </div>

        {/* Projects grid: make each project clickable to open Annotator */}
        {projError ? (
          <div className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded p-3">
            Failed to load projects: {projError.message}
          </div>
        ) : projects.length === 0 ? (
          <div className="text-sm text-muted-foreground">No projects found. Create one above.</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const href = `/projects/${p.id}/annotate${p.origin ? `?url=${encodeURIComponent(p.origin)}` : ""}`;
              return (
                <Card key={p.id} className="h-full transition hover:shadow-md">
                  {/* Clickable area opens the annotator */}
                  <Link href={href} className="block">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">{p.name ?? "Untitled Project"}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-xs text-muted-foreground">
                      {p.origin ? (
                        <span className="truncate block">{p.origin}</span>
                      ) : (
                        <span>Click to open annotator</span>
                      )}
                    </CardContent>
                  </Link>
                  {/* Management tools stay on the card */}
                  <CardFooter className="flex items-center justify-between">
                    <MembersDialog
                      projectId={p.id}
                      members={membersByProject.get(p.id) ?? []}
                      onInviteByEmail={inviteMemberByEmail}
                      onRemove={removeMember}
                    />
                    <form action={deleteProject}>
                      <input type="hidden" name="id" value={p.id} />
                      <Button type="submit" size="sm" variant="destructive" className="m-4">
                        Delete
                      </Button>
                    </form>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
