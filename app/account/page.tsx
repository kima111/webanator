import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import ProfileForm from "@/components/account/profile-form";

export default async function AccountPage() {
  const supabase = await createClient();
  const { data: userResp } = await supabase.auth.getUser();
  const user = userResp?.user ?? null;
  if (!user) redirect("/auth/login");

  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const first_name = typeof meta.first_name === "string" ? meta.first_name : "";
  const last_name = typeof meta.last_name === "string" ? meta.last_name : "";
  const username = typeof meta.username === "string" ? meta.username : "";

  return (
    <div className="container mx-auto max-w-7xl py-8">
      <Card className="w-full">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Account</CardTitle>
              <CardDescription>Manage your profile details.</CardDescription>
            </div>
            <Link href="/protected" className="text-sm underline decoration-dotted hover:decoration-solid">
              ← Back
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <ProfileForm
            email={user.email ?? ""}
            username={username}
            firstName={first_name}
            lastName={last_name}
          />
        </CardContent>
      </Card>
    </div>
  );
}