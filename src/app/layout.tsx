import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/offline/service-worker-register";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "FleetWise";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: "Farm machinery & vehicle manager for South African farms.",
  manifest: "/manifest.webmanifest",
  applicationName: APP_NAME,
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#166534",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-sand-50 font-sans text-sand-900 antialiased">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
