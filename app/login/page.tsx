import { redirect } from "next/navigation";

export default function LoginAliasPage() {
  // Alias: /login -> /auth/login
  redirect("/auth/login");
}
