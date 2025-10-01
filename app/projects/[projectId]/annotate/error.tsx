"use client";
import { useEffect } from "react";

// Route Error Boundary for Annotate page
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
  // Optional: report to console for quick inspection
  // Using console for diagnostics here is acceptable in an error boundary context
  // eslint-disable-next-line no-console
  console.error("Annotate route error:", error);
  }, [error]);

  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-md border bg-background p-5 shadow">
        <h2 className="mb-2 text-base font-semibold">Something went wrong</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          The annotator ran into an error and has been isolated so the whole app doesn&apos;t crash.
        </p>
        {error?.message ? (
          <pre className="mb-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
            {String(error.message)}
          </pre>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
            onClick={() => reset()}
          >
            Try again
          </button>
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={() => {
              try {
                localStorage.setItem("annotatorDebug", "1");
                location.reload();
              } catch {
                reset();
              }
            }}
            title="Enable proxy debug and reload"
          >
            Enable debug & reload
          </button>
        </div>
      </div>
    </div>
  );
}
