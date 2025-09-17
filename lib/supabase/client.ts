// Expose createClient for browser debugging
if (typeof window !== "undefined") {
  // @ts-expect-error Expose createClient for browser debugging (window type is not augmented)
    window.createClient = createClient;
}
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY!,
  );
}
