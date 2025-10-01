import { redirect } from "next/navigation";

export default function SignupAliasPage() {
  // Alias: /signup -> /auth/sign-up
  redirect("/auth/sign-up");
}
