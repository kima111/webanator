/* eslint-disable @next/next/no-img-element */
import { notFound } from "next/navigation";

// Simple utility to get a single string from possible array
function first(v: unknown): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return typeof v === "string" ? v : "";
}

function decodePossiblyDouble(value: string): string {
  let out = value;
  for (let i = 0; i < 2; i++) {
    try {
      const dec = decodeURIComponent(out);
      if (dec === out) break;
      out = dec;
    } catch {
      break;
    }
  }
  return out;
}

// In Next.js 15, searchParams is now asynchronous; await it to avoid warning.
export default async function ImageViewerPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const sp = await searchParams;
  const encoded = first(sp?.src);
  if (!encoded) notFound();
  const src = decodePossiblyDouble(encoded);
  let urlOk = true;
  if (src.startsWith("/api/storage/image/")) {
    urlOk = true;
  } else if (src.startsWith("/")) {
    // other same-origin internal paths are allowed
    urlOk = true;
  } else {
    try {
      const u = new URL(src);
      urlOk = /^https?:$/.test(u.protocol);
    } catch { urlOk = false; }
  }
  if (!urlOk) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-black text-white p-6 text-sm">
        <h1 className="font-semibold mb-2">Invalid image source</h1>
        <div className="opacity-80 break-all max-w-[90vw]">{encoded}</div>
        <div className="opacity-50 break-all mt-2 text-xs">Decoded: {src}</div>
      </div>
    );
  }
  return (
    <div className="relative w-screen h-screen bg-background">
      {/* subtle, theme-aware texture using CSS variables */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, hsl(var(--foreground) / 0.06) 1px, transparent 1px)",
          backgroundSize: "12px 12px",
        }}
      />
      <div className="w-full h-full flex items-start justify-center pt-6 px-2">
        <img
          src={src}
          alt="Project Image"
          className="w-auto h-auto max-w-[100vw] max-h-[calc(100vh-2rem)] object-contain"
        />
      </div>
    </div>
  );
}