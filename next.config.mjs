/**
 * The content security policy is NOT set here. It carries a fresh nonce per request, so the
 * middleware builds and sends it (src/middleware.ts, src/lib/security/csp.ts); a header from
 * this file would be the same on every response. The headers below are the fixed ones.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No `X-Powered-By: Next.js` on every response: it tells a scanner what to try first.
  poweredByHeader: false,
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
          // HTTPS only for two years, subdomains too. Deliberately NOT `preload`: the preload
          // list is hard to leave, and the decision belongs to whoever owns the domain.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          // A page another site opens cannot reach this one through window.opener, nor this
          // one reach it. Nothing here opens a popup (payments are a redirect in the same tab).
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
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
