import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The FLEETWISE Android app (task B6, docs/ANDROID.md). It opens the hosted app at its own address
 * rather than a bundled copy: the app is server-rendered and its forms post server actions, which
 * cannot be exported as static files (docs/NATIVE_APP_AND_OFFLINE_PLAN.md section 2). Capacitor's
 * documentation says `server.url` is "not intended for use in production"; the trade-off is
 * recorded in docs/ANDROID.md. CAP_SERVER_URL points a test build at a preview or staging address.
 */
const serverUrl = process.env.CAP_SERVER_URL ?? "https://app.fleet-wise.co.za";

const config: CapacitorConfig = {
  // Permanent once published on Google Play (founder decision; docs/ANDROID.md).
  appId: "za.co.fleetwise.app",
  appName: "FLEETWISE",
  // Two local pages only: the start screen and the "no connection" page.
  webDir: "native/www",
  server: {
    url: serverUrl,
    androidScheme: "https",
    // Shown when the app's address cannot be reached (no signal on first open). No plugins there.
    errorPath: "offline.html",
  },
  android: {
    // The background-geolocation plugin's README: keeps location updates arriving after five
    // minutes in the background. Trade-off (the bridge is reachable from iframes the CSP allows) in
    // docs/ANDROID.md.
    useLegacyBridge: true,
    // A WebView this old cannot take Capacitor's bridge as a document-start script; Capacitor would
    // fetch pages itself, inject an inline script and drop the app's content security policy. Older
    // WebViews get the error page and an update instead.
    minWebViewVersion: 100,
    allowMixedContent: false,
    captureInput: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    // The app draws edge to edge (always, from Android 15). The status bar's height reaches the
    // page as CSS (`insetsHandling: "css"`, read by globals.css --safe-top). The page declares
    // viewport-fit=cover (src/app/layout.tsx); saying so here hands it the height from the first
    // frame, where Capacitor otherwise pads the view until the page has loaded and then jumps.
    SystemBars: { insetsHandling: "css", initialViewportFitValueHint: "cover" },
    // Native requests (positions sent in the background) use the WebView's own sign-in cookies.
    CapacitorCookies: { enabled: true },
    // Only called directly for positions; fetch and XHR in the app stay the WebView's own.
    CapacitorHttp: { enabled: false },
  },
};

export default config;
