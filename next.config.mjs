/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mobile-first, low-bandwidth: keep the client bundle lean.
  experimental: {
    // The add-vehicle form ferries a client-compressed primary photo (base64 data
    // URL, ~200–400 KB) through a server action; raise the body limit above the 1 MB
    // default for headroom.
    serverActions: { bodySizeLimit: "4mb" },
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
