"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Member = { project_id: string; user_id: string; role?: string | null; email?: string | null; email_confirmed?: boolean; joined_at?: string | null };

export default function MembersDialog({
  projectId,
  members,
  onInviteByEmail,
  onRemove,
}: {
  projectId: string;
  members: Member[];
  onInviteByEmail: (formData: FormData) => Promise<string | undefined> | void;
  onRemove: (formData: FormData) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [inviteLink, setInviteLink] = useState<string | undefined>();
  const [inviteStatus, setInviteStatus] = useState<"idle" | "success" | "error">("idle");
  const [email, setEmail] = useState("");
  const [lastInvitedEmail, setLastInvitedEmail] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">Manage Members</Button>
      </DialogTrigger>
     <DialogContent className="w-[95vw] sm:max-w-2xl md:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Project Members</DialogTitle>
          <DialogDescription>
            Invite by email and manage existing members for this project.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 pr-1 max-h-[70vh] overflow-y-auto">
          <form
            action={(fd) =>
              startTransition(async () => {
                setInviteStatus("idle");
                setErrorText(null);
                try {
                  const link = (await onInviteByEmail(fd)) as string | undefined;
                  if (link) {
                    setInviteLink(link);
                  } else {
                    throw new Error("No link returned");
                  }
                  const submittedEmail = fd.get("email");
                  if (typeof submittedEmail === "string" && submittedEmail) {
                    setLastInvitedEmail(submittedEmail);
                  }
                  setEmail("");
                  setInviteStatus("success");
                  setTimeout(() => setInviteStatus("idle"), 2500);
                  router.refresh();
                } catch (e: unknown) {
                  setInviteStatus("error");
                  const msg = typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : null;
                  setErrorText(msg ?? "Unknown error");
                  setTimeout(() => setInviteStatus("idle"), 2500);
                }
              })
            }
            className="flex items-center gap-2 flex-wrap"
          >
            <input type="hidden" name="project_id" value={projectId} />
            <Input
              name="email"
              type="email"
              placeholder="email@example.com"
              className="h-9"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <select
              name="role"
              defaultValue="viewer"
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <Button type="submit" size="sm" disabled={isPending}>Invite</Button>
          </form>

          <div className="flex items-center gap-2">
            <form
              action={(fd) =>
                startTransition(async () => {
                  setInviteStatus("idle");
                  setErrorText(null);
                  try {
                    const link = (await onInviteByEmail(fd)) as string | undefined;
                    if (link) setInviteLink(link);
                    setInviteStatus("success");
                    setTimeout(() => setInviteStatus("idle"), 2500);
                    router.refresh();
                  } catch {
                    setInviteStatus("error");
                    setTimeout(() => setInviteStatus("idle"), 2500);
                  }
                })
              }
            >
              <input type="hidden" name="project_id" value={projectId} />
              <input type="hidden" name="email" value={lastInvitedEmail ?? ""} />
              <Button type="submit" size="sm" variant="ghost" disabled={isPending || !lastInvitedEmail}>Resend Invite</Button>
            </form>
            {lastInvitedEmail && (
              <div className="text-xs text-muted-foreground">Last: {lastInvitedEmail}</div>
            )}
          </div>

          {inviteStatus === "success" && (
            <div className="text-xs text-emerald-500">Invite created. Check email or use the link below.</div>
          )}
          {inviteStatus === "error" && (
            <div className="text-xs text-red-500">Failed to create invite. {errorText ? `(${errorText})` : "Try again."}</div>
          )}

          {inviteLink && (
            <div className="rounded-md border p-2 text-xs">
              Invitation link (click to open, or copy/share):
              <div className="mt-1 break-all font-mono">
                <a
                  href={inviteLink}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline break-all"
                >
                  {inviteLink}
                </a>
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => window.open(inviteLink, "_blank", "noreferrer")}
                >
                  Open Link
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(inviteLink)}
                >
                  Copy Link
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {members.length === 0 ? (
              <div className="text-sm text-muted-foreground">No members yet.</div>
            ) : (
              members.map((m) => (
                <div key={`${m.project_id}-${m.user_id}`} className="flex items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-mono">{m.email ?? m.user_id}</span>
                    {m.role && (
                      <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                        {m.role}
                      </span>
                    )}
                    <span className="ml-2 text-xs text-muted-foreground">{m.joined_at ? "member" : "pending"}</span>
                  </div>
                 <div className="flex gap-1 flex-wrap">
                    <form
                      action={(fd) =>
                        startTransition(async () => {
                          setInviteStatus("idle");
                          setErrorText(null);
                          try {
                            fd.set("project_id", projectId);
                            fd.set("email", m.email ?? "");
                            const link = (await onInviteByEmail(fd)) as string | undefined;
                            if (link) setInviteLink(link);
                            setInviteStatus("success");
                            setTimeout(() => setInviteStatus("idle"), 2500);
                            router.refresh();
                          } catch {
                            setInviteStatus("error");
                            setTimeout(() => setInviteStatus("idle"), 2500);
                          }
                        })
                      }
                    >
                      <input type="hidden" name="project_id" value={projectId} />
                      <input type="hidden" name="email" value={m.email ?? ""} />
                      <Button type="submit" size="sm" variant="outline" disabled={isPending || !m.email}>Resend</Button>
                    </form>
                    <form
                      action={(fd) =>
                        startTransition(async () => {
                          await onRemove(fd);
                          router.refresh();
                        })
                      }
                    >
                      <input type="hidden" name="project_id" value={projectId} />
                      <input type="hidden" name="member_user_id" value={m.user_id} />
                      <Button type="submit" variant="ghost" size="sm" disabled={isPending}>Remove</Button>
                    </form>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
