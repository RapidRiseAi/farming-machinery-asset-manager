import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/offline/service-worker-register";
import { deviceLocale } from "@/lib/locale";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "FleetWise";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: "Farm machinery & vehicle manager for South African farms.",
  manifest: "/manifest.webmanifest",
  applicationName: APP_NAME,
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#166534",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // `lang` drove screen readers and hyphenation to English on every page of a
  // bilingual product. The device locale (cookie → Accept-Language) is the one signal
  // available this high in the tree; `setLanguage` mirrors a signed-in user's profile
  // choice into the same cookie, so the two agree. Audit bug 2.
  const locale = await deviceLocale();
  return (
    <html lang={locale}>
      <body className="min-h-dvh bg-sand-50 font-sans text-sand-900 antialiased">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
