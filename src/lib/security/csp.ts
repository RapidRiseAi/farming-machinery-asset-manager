/**
 * The content security policy, ENFORCED (H6; report-only from 14 October, enforced 13 November
 * 2026). Built per request by the middleware (src/middleware.ts), which sends it on every
 * response and hands it to Next.js as a request header: Next reads the nonce from that header
 * and puts it on its own scripts. Our inline scripts in the root layout read it from
 * NONCE_HEADER. Violations are still reported to /api/csp-report.
 *
 * script-src is 'self' 'nonce-<n>' 'strict-dynamic': a script runs only if it carries this
 * response's nonce, or was added by a script that did (Next's chunks, the Turnstile script the
 * widget appends). Browsers that know 'strict-dynamic' ignore 'self' and host sources; older
 * ones fall back to them. There is no 'unsafe-inline' and no 'unsafe-eval'.
 *
 * style-src keeps 'unsafe-inline' on purpose: React style props across the app (bar and meter
 * widths, Tailwind values set at run time), MapLibre's positioned markers, popups and canvas,
 * and Next's route announcer all set inline styles, and a nonce cannot be put on a style
 * attribute. Adding a nonce to style-src would also switch 'unsafe-inline' off. CSS cannot
 * run script, so this is the accepted trade.
 *
 * Every origin below is one the BROWSER talks to. Mapbox directions and Nominatim place search
 * are called from the server only (src/lib/routing/providers.ts), so they are not here.
 */

/** The request header carrying this request's nonce to server components (the root layout). */
export const NONCE_HEADER = "x-nonce";

/**
 * Cloudflare Turnstile, the bot check on sign-up, sign-in and the partner form
 * (src/lib/security/turnstile.ts): its script, its iframe and its calls home. Named ONLY when
 * the site key is set at build time, so without it the policy is as tight as before.
 */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** OpenFreeMap (src/components/map/map-style.ts): style JSON, tiles, glyphs and sprites. */
export const MAP_TILES_ORIGIN = "https://tiles.openfreemap.org";

/** Azure Speech, live dictation: the SDK speaks https and wss to <region>.*.speech.microsoft.com. */
const SPEECH = ["https://*.speech.microsoft.com", "wss://*.speech.microsoft.com"];

/**
 * Where a form may send the browser. Paystack: the billing Pay buttons post to our own server
 * actions, which redirect to Paystack's hosted checkout, and a redirect after a form post is
 * checked against form-action. PayFast: a public invoice's Pay now (LeavingForm) posts
 * straight to PayFast's process URL (src/lib/payments/payfast.ts).
 */
export const PAYSTACK_CHECKOUT_ORIGIN = "https://checkout.paystack.com";
export const PAYFAST_ORIGIN = "https://www.payfast.co.za";
export const PAYFAST_SANDBOX_ORIGIN = "https://sandbox.payfast.co.za";

export type CspOptions = {
  /** This response's nonce, from createNonce(). */
  nonce: string;
  /** NEXT_PUBLIC_SUPABASE_URL: REST, Storage (signed photo and voice URLs) and Realtime. */
  supabaseUrl?: string | null;
  /** True when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set. */
  turnstile?: boolean;
  /** True when PAYFAST_SANDBOX is "1": invoices post to PayFast's sandbox instead. */
  payfastSandbox?: boolean;
};

/**
 * A nonce as CSP and Next.js read it: base64 of at least 16 random bytes. Checked because it
 * goes into a header and into the page: anything else (a quote, a semicolon, a space) could
 * end the source list or the attribute.
 */
const NONCE_PATTERN = /^[A-Za-z0-9+/]{22,}={0,2}$/;

/** 16 random bytes, base64. Uses Web Crypto, so it runs in the middleware and in Node. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { origin, protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? origin : null;
  } catch {
    return null;
  }
}

/** The policy, one directive per entry, joined with "; ". Pure: same options, same policy. */
export function buildContentSecurityPolicy(options: CspOptions): string {
  const { nonce } = options;
  if (!NONCE_PATTERN.test(nonce)) throw new Error("content security policy: the nonce is not base64");
  const supabase = originOf(options.supabaseUrl);
  const supabaseSocket = supabase ? supabase.replace(/^http/, "ws") : null;
  const turnstile = options.turnstile ? [TURNSTILE_ORIGIN] : [];
  const payfast = options.payfastSandbox ? [PAYFAST_ORIGIN, PAYFAST_SANDBOX_ORIGIN] : [PAYFAST_ORIGIN];
  const list = (...sources: Array<string | null>) => sources.filter((s): s is string => !!s).join(" ");

  return [
    "default-src 'self'",
    `script-src ${list("'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...turnstile)}`,
    "style-src 'self' 'unsafe-inline'",
    // data: for MapLibre's WebP probe and Supabase's two-step QR code; blob: for photo
    // previews and map images; the tile host for the map's raster layer and sprites.
    `img-src ${list("'self'", "data:", "blob:", supabase, MAP_TILES_ORIGIN)}`,
    `media-src ${list("'self'", "blob:", supabase)}`,
    "font-src 'self' data:",
    `connect-src ${list("'self'", supabase, supabaseSocket, MAP_TILES_ORIGIN, ...SPEECH, ...turnstile)}`,
    // MapLibre runs its worker from a blob: URL; the service worker is /sw.js. child-src is
    // the older name some Safari versions read for workers.
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    `frame-src ${list("'self'", ...turnstile)}`,
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${list("'self'", PAYSTACK_CHECKOUT_ORIGIN, ...payfast)}`,
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    "report-uri /api/csp-report",
  ].join("; ");
}
