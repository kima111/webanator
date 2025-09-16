// app/api/projects/create/route.ts
import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Deprecated: create projects from /protected" },
    { status: 410 }
  );
}
