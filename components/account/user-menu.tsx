"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import NextImage from "next/image";

export function UserMenu({ avatarUrl, username, email }: { avatarUrl: string; username?: string; email?: string }) {
  const router = useRouter();

  const onLogout = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/auth/login");
  }, [router]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center h-8 w-8 rounded-full focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          aria-label="Open user menu"
        >
          <NextImage
            src={avatarUrl}
            alt="User avatar"
            width={32}
            height={32}
            unoptimized
            className="h-8 w-8 rounded-full border object-cover"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {(username || email) && (
          <DropdownMenuLabel className="space-y-0.5">
            {username && <div className="text-sm font-semibold leading-tight">{username}</div>}
            {email && <div className="text-xs text-muted-foreground leading-tight">{email}</div>}
          </DropdownMenuLabel>
        )}
        {(username || email) && <DropdownMenuSeparator />}
        <DropdownMenuItem asChild>
          <Link href="/account">Profile</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-red-600 focus:text-red-600"
          onSelect={(e) => {
            e.preventDefault();
            onLogout();
          }}
        >
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
