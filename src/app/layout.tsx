import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/offline/service-worker-register";
import { RouteProgress } from "@/components/ui/route-progress";
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
  // FleetWise Green (Official Colour Palette). Was #166534, while the manifest
  // said #16a34a — stock Tailwind green, a colour in no token file anywhere — so
  // the address bar, the PWA splash and the app were three different greens.
  themeColor: "#00572c",
  width: "device-width",
  initialScale: 1,
  // NO `maximumScale`. It was set to 1, which caps magnification at 1x and stops
  // a farmer spreading to read a serial number in the sun. That is a WCAG 2.1
  // SC 1.4.4 (Level AA) failure, and it applied to every screen in the product.
  // It is usually added to stop iOS zooming on a focused input; the real cure for
  // that is a >=16px font size on inputs, which the kit's `controlBase` already has.

  // Without this, every `env(safe-area-inset-*)` in globals.css resolves to 0px —
  // so `.pb-safe` did nothing in its three call sites and `.h-safe-tabbar` was
  // written and never used. On a phone with gesture navigation the fixed bottom
  // tab bar was sitting under the system gesture strip.
  viewportFit: "cover",
};

/**
 * Applies the stored theme before first paint.
 *
 * Without this a dark-theme user gets a flash of the cream ground on every cold
 * load, because the class can only be set once React has hydrated. Kept to one
 * statement, wrapped so a browser with storage blocked (private mode, or a
 * locked-down farm-office machine) falls through to the OS preference rather
 * than throwing before the app has rendered anything.
 */
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem('fleetwise:theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // `lang` drove screen readers and hyphenation to English on every page of a
  // bilingual product. The device locale (cookie → Accept-Language) is the one signal
  // available this high in the tree; `setLanguage` mirrors a signed-in user's profile
  // choice into the same cookie, so the two agree. Audit bug 2.
  const locale = await deviceLocale();
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      {/* Surfaces come from the semantic tokens so the whole app follows the
          theme without a single component knowing which theme it is in. */}
      <body className="min-h-dvh bg-surface-raised font-sans text-ink antialiased">
        {/* Acknowledges a tap immediately, on every screen including the public QR
            pages — every route here is dynamic, so there is always a wait to cover. */}
        <RouteProgress />
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
