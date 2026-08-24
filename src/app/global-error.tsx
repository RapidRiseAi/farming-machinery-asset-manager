"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-report";

/**
 * The last boundary: an error in the ROOT layout itself.
 *
 * `(app)/error.tsx` covers a signed-in page that throws, but it renders *inside* the root
 * layout — so if the root layout is what failed, nothing catches it and Next shows its own
 * blank default. That is also the failure a farmer is least able to describe, because there
 * is nothing on screen to describe.
 *
 * This file replaces the whole document when it renders, which is why it must supply its own
 * `<html>` and `<body>`, and why the styling is inline rather than from the design system:
 * if the layout failed, the stylesheet may be exactly what did not load.
 *
 * Colours are the app's own tokens written out as literals (sand-50 ground, sand-950 ink,
 * status-overdue), so the page still looks like FleetWise with no CSS at all.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, "root-layout");
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#faf9f7",
          color: "#26221c",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          padding: "1.5rem",
        }}
      >
        <main style={{ maxWidth: "28rem", width: "100%" }}>
          <p
            style={{
              margin: 0,
              fontSize: ".75rem",
              fontWeight: 600,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: "#dc2626",
            }}
          >
            FleetWise
          </p>
          <h1 style={{ margin: ".5rem 0 0", fontSize: "1.35rem", lineHeight: 1.3 }}>
            The app did not start
          </h1>
          <p style={{ margin: ".75rem 0 0", color: "#6b6356", fontSize: ".95rem", lineHeight: 1.6 }}>
            Something went wrong on our side, not yours, and nothing you entered has been lost.
            Try again — if it keeps happening, the farm office can send us the code below.
          </p>
          <div style={{ marginTop: "1.25rem", display: "flex", gap: ".6rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                minHeight: "48px",
                padding: "0 1.1rem",
                border: 0,
                borderRadius: ".5rem",
                background: "#15803d",
                color: "#fff",
                fontSize: ".95rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a
              href="/home"
              style={{
                minHeight: "48px",
                display: "inline-flex",
                alignItems: "center",
                padding: "0 1.1rem",
                borderRadius: ".5rem",
                border: "1px solid #d8d2c7",
                background: "#fff",
                color: "#26221c",
                fontSize: ".95rem",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Go to my home screen
            </a>
          </div>
          {error.digest ? (
            <p
              style={{
                margin: "1.25rem 0 0",
                paddingTop: ".75rem",
                borderTop: "1px solid #e9e5dd",
                fontSize: ".78rem",
                color: "#8a8173",
              }}
            >
              Reference: <span style={{ fontFamily: "ui-monospace, monospace" }}>{error.digest}</span>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
