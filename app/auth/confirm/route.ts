import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/";

  if (token_hash && type) {
    const supabase = await createClient();

    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash,
    });
    if (!error) {
      // Mark membership acceptance: set joined_at for this user across pending memberships
      try {
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (uid) {
          const admin = createAdminClient();
          await admin
            .from("project_members")
            .update({ joined_at: new Date().toISOString() })
            .is("joined_at", null)
            .eq("user_id", uid);
        }
      } catch {
        // non-blocking
      }
      // Show a brief success message before redirecting
      const destination = next;
      const html = `<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Success</title>
            <meta http-equiv="refresh" content="1;url=${destination}" />
            <style>
              body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Apple Color Emoji, Segoe UI Emoji; padding: 2rem; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0b0b0b; color: #f5f5f5; }
              .card { max-width: 460px; width: 100%; border: 1px solid #333; border-radius: 12px; padding: 20px; background: #121212; }
              .title { font-size: 20px; font-weight: 700; margin: 0 0 8px; }
              .desc { font-size: 14px; color: #b0b0b0; margin-bottom: 16px; }
              .btn { display: inline-block; background: #3b82f6; color: white; padding: 8px 12px; border-radius: 8px; text-decoration: none; font-size: 14px; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="title">You’re verified</div>
              <div class="desc">You’re all set. Redirecting to your dashboard…</div>
              <a class="btn" href="${destination}">Continue</a>
            </div>
          </body>
        </html>`;
      return new Response(html, { headers: { "content-type": "text/html" } });
    } else {
      // redirect the user to an error page with some instructions
      redirect(`/auth/error?error=${error?.message}`);
    }
  }

  // redirect the user to an error page with some instructions
  redirect(`/auth/error?error=No token hash or type`);
}
