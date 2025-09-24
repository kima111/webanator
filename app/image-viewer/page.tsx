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
    // internal proxied path
    urlOk = true;
  } else {
    try {
      const u = new URL(src);
      if (!/^https?:$/.test(u.protocol)) urlOk = false;
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
    <div className="w-full h-full flex items-center justify-center bg-black">
      <img src={src} alt="Project Image" className="max-w-full max-h-full object-contain" />
    </div>
  );
}