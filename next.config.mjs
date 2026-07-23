/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mobile-first, low-bandwidth: keep the client bundle lean.
  experimental: {
    // Nothing enabled yet; placeholder for future optimizations.
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
