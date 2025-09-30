// app/projects/[projectId]/annotate/page.tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AnnotatorShell from "./_components/AnnotatorShell";

type Params = { projectId: string };
type Search = { url?: string | string[] };

type PageProps = {
  params: Promise<Params>;
  searchParams?: Promise<Search>;
};

export default async function AnnotatePage(props: PageProps) {
  const params = await props.params;
  const searchParams = props.searchParams ? await props.searchParams : undefined;

  const projectId = params.projectId;

  // normalize ?url=
  const raw = searchParams?.url;
  const initialUrl = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");

  const supa = await createClient();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) redirect("/login");

  // must be a member
  const { data: member } = await supa
    .from("project_members")
    .select("project_id")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!member) redirect("/404");

  // optional: fetch project name for header
  const { data: proj } = await supa
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .maybeSingle();

  // Pass the external URL to the client shell; it will proxy when rendering

  return (
    <>
      <div className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto h-12 px-4 flex items-center justify-between">
          <Link href="/protected" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
          <div className="text-sm font-medium truncate">{proj?.name ?? "Project"}</div>
          <div className="w-[48px]" />
        </div>
      </div>

      {/* Full-bleed wrapper with reserved height under the sticky header */}
      <div className="w-[95vw] mx-auto grid grid-rows-[auto_1fr] gap-3 min-h-[calc(100vh-3rem)]">
        <div className="text-xs text-muted-foreground py-2 text-center">
          Tip: Hold <kbd className="px-1 py-0.5 border rounded">Shift</kbd> and click inside the page to create a pin.
        </div>
        <div className="min-h-0">
          <AnnotatorShell projectId={projectId} initialUrl={initialUrl} />
        </div>
      </div>
    </>
  );
}
