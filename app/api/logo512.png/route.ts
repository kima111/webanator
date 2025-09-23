import { NextResponse } from "next/server";
export const runtime = "nodejs";

// 1x1 transparent PNG (base64)
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

export async function GET() {
  const buf = Buffer.from(PNG_BASE64, "base64");
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=3600",
    },
  });
}
