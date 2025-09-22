import Link from "next/link";
import { Button } from "./ui/button";
import { createClient } from "@/lib/supabase/server";
import { ThemeSwitcher } from "./theme-switcher";
import { UserMenu } from "@/components/account/user-menu";

export async function AuthButton() {
  const supabase = await createClient();

  // Prefer full user (for user_metadata.avatar_url)
  const { data: userResp } = await supabase.auth.getUser();
  const user = userResp?.user;
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const _meta = meta as Partial<{ first_name: string; last_name: string; username: string; avatar_url: string }>;
  const first_name = typeof _meta.first_name === "string" ? _meta.first_name : "";
  const last_name = typeof _meta.last_name === "string" ? _meta.last_name : "";
  const username = typeof _meta.username === "string" ? _meta.username : undefined;
  const displayName = [first_name, last_name].filter(Boolean).join(" ").trim();
  const seed = displayName || (user?.email ?? "User");
  const dicebear = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(seed)}`;
  const avatarFromMeta = typeof _meta.avatar_url === "string" ? _meta.avatar_url : undefined;
  const avatarUrl = avatarFromMeta && avatarFromMeta.length > 0 ? avatarFromMeta : dicebear;

  return user ? (
    <div className="flex items-center gap-3">
      <UserMenu avatarUrl={avatarUrl} username={username} email={user?.email ?? undefined} />
      <ThemeSwitcher />
    </div>
  ) : (
    <div className="flex gap-2">
      <Button asChild size="sm" variant={"outline"}>
        <Link href="/auth/login">Sign in</Link>
      </Button>
      <Button asChild size="sm" variant={"default"}>
        <Link href="/auth/sign-up">Sign up</Link>
      </Button>
      <ThemeSwitcher />
    </div>
  );
}
