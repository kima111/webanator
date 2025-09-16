"use client";
import { redirect } from "next/navigation";

export default function ProjectsPage() {
  redirect("/protected");
  return null;
}
