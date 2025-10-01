import { redirect } from "next/navigation";

export default function ForgotPasswordAliasPage() {
  // Alias: /forgot-password -> /auth/forgot-password
  redirect("/auth/forgot-password");
}
