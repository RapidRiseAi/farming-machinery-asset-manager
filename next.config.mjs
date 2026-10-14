/**
 * Content security policy, REPORT-ONLY (H6): browsers report what it would block to
 * /api/csp-report and block nothing. Once the reports are quiet it can be enforced by
 * renaming the header. Inline scripts and styles stay allowed: the App Router's own
 * bootstrap is inline and this app uses no nonces. Beyond its own origin the browser talks
 * only to Supabase (signed photo and voice URLs) and Azure Speech (live dictation).
 */
const supabaseOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
  } catch {
    return "";
  }
})();
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${supabaseOrigin}`,
  `media-src 'self' blob: ${supabaseOrigin}`,
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseOrigin} ${supabaseOrigin.replace(/^https:/, "wss:")} https://*.speech.microsoft.com wss://*.speech.microsoft.com`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "report-uri /api/csp-report",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep tracing anchored to this application when a parent folder also has a lockfile.
  outputFileTracingRoot: process.cwd(),
  // Mobile-first, low-bandwidth: keep the client bundle lean.
  experimental: {
    // The add-vehicle form ferries a client-compressed primary photo (base64 data
    // URL, ~200-400 KB) through a server action; raise the body limit above the 1 MB
    // default for headroom.
    //
    // Raised again to 10 MB for supplier tax invoices (G6 receipts), which are NOT
    // compressed on the way in: a receipt is evidence, and a PDF cannot be resized like a
    // photo. `uploadReceipt` caps the file itself at 8 MB, and the ceiling here is kept
    // deliberately above that cap so an oversized file trips OUR message ("that file is
    // too big") rather than dying inside the framework with nothing to show the user.
    serverActions: { bodySizeLimit: "10mb" },
  },
  async headers() {
    // The offline service worker must be revalidated (never stuck in cache) and be
    // allowed to control the whole origin.
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=(self), payment=()",
          },
          { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
