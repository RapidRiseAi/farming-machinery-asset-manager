/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mobile-first, low-bandwidth: keep the client bundle lean.
  experimental: {
    // The add-vehicle form ferries a client-compressed primary photo (base64 data
    // URL, ~200–400 KB) through a server action; raise the body limit above the 1 MB
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
