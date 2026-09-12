import type { Config } from "tailwindcss";

/**
 * FleetWise design tokens — built on the Official Colour Palette
 * (`FleetWise_Official_Colour_Palette.pdf`, internal brand reference).
 *
 * The seven brand colours are ANCHORS, pinned to exact hex values and never
 * altered:
 *
 *   Primary  FleetWise Green  #00572C  → brand-600
 *   Accent   FleetWise Gold   #EAA50C  → gold-500
 *   Dark     FleetWise Black  #000000  → sand-950
 *   Light    Warm Cream       #F7F3E8  → sand-50   (page ground)
 *   Pure     White            #FFFFFF  → white     (cards)
 *   Body     Charcoal         #242824  → sand-900  (body text)
 *   Muted    Warm Grey        #E6E2D7  → sand-200  (dividers, secondary surfaces)
 *
 * Every other step is a TINT OR SHADE of an anchor, derived so it can do a job
 * the anchor cannot do accessibly. The brand rule ("no additional brand accent
 * colours") is about accents; a darker shade of the same hue is not a new
 * accent, and two of them are unavoidable:
 *
 *   • Gold #EAA50C is 1.92:1 on cream — it CANNOT carry text. It is a fill
 *     (black on gold = 9.89:1). `gold-600` #936505 is the same hue darkened
 *     until it clears 4.5:1, so "important numbers" can be gold and legible.
 *   • Warm Grey #E6E2D7 is 1.17:1 on cream — a lovely surface tint and an
 *     invisible border. `sand-300` is the shade that reaches the 3:1 that
 *     WCAG SC 1.4.11 requires of a control boundary.
 *
 * The neutral ramp travels from the warm yellow of the cream to the faint green
 * cast of the charcoal (#242824 has more green than red or blue) — the brand's
 * own two ends, joined rather than replaced by a generic grey.
 *
 * EVERY step below was solved numerically against the real page ground and
 * verified, not chosen by eye. Ratios in the comments are measured on
 * cream #F7F3E8; on white cards each is ~11% higher.
 *
 * Semantic status colours (Scope §4.3) are FUNCTIONAL, not brand accents:
 * `ok` is the brand green itself and `due` is a shade of the brand gold, so the
 * traffic light is drawn almost entirely from the palette. `overdue` red is the
 * one functional colour outside it and is used ONLY for overdue/fault/destructive
 * states — never as chrome.
 */
const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  // Theme is driven by a `data-theme` attribute on <html> so an explicit user
  // choice beats the OS setting in both directions; absent the attribute the
  // media query in globals.css decides.
  darkMode: ["variant", [
    "@media (prefers-color-scheme: dark) { &:not([data-theme=light] *) }",
    "&:is([data-theme=dark] *)",
  ]],
  theme: {
    extend: {
      colors: {
        // ── Primary: FleetWise Green. 600 is the exact brand hex and carries
        //    buttons, headings and navigation. White on it = 8.75:1.
        brand: {
          50: "#e8f2ec",
          100: "#c9e2d5",
          200: "#97c8ad",
          300: "#5faa84", //  dark-theme text green (5.13:1 on the dark surface)
          400: "#2a8a5f",
          500: "#0a6e3c", //  5.72:1 — hover/active partner
          600: "#00572c", // ★ FleetWise Green — 7.89:1
          700: "#014524", // 10.09:1 — hover
          800: "#013620",
          900: "#012718",
          950: "#001a0f",

          /**
           * The brand green AS TEXT on whatever surface is current.
           *
           * #00572C is 7.89:1 on cream and 1.27:1 on near-black, so a heading or
           * a link cannot use a fixed step and work in both themes. `brand-ink`
           * resolves to brand-700 in light and brand-300 in dark.
           *
           * `bg-brand-600` deliberately stays literal — a green button is the
           * brand's green in both themes; only TEXT needs to move.
           */
          ink: "rgb(var(--brand-ink) / <alpha-value>)",
          /** Chip / callout ground that follows the theme. */
          tint: "rgb(var(--brand-tint) / <alpha-value>)",
        },
        // ── Accent: FleetWise Gold. 500 is the exact brand hex and is a FILL
        //    ONLY (1.92:1 — never text on a light ground). 600+ are the text
        //    shades. Keep gold deliberate: CTAs, key figures, selected states.
        gold: {
          50: "#fdf7e6",
          100: "#fbedc6",
          200: "#f7dc8d",
          300: "#f3c74f",
          400: "#eeb423",
          500: "#eaa50c", // ★ FleetWise Gold — fill only
          600: "#936505", //  4.61:1 — the lightest gold that may carry text
          700: "#6f4c04",
          800: "#4d3506",
          900: "#332305",
          950: "#1f1503",
        },
        /**
         * ── Neutral: Warm Cream → Warm Grey → Charcoal → Black.
         *
         * Resolved from CSS variables rather than fixed hex, because this scale
         * carries the app's ENTIRE neutral vocabulary — ~1,500 usages of
         * `text-sand-500`, `bg-sand-50`, `border-sand-200` across 445 files.
         * Fixed hex made every one of them light-only.
         *
         * A step is a ROLE (distance from the page ground), not an absolute
         * lightness, so the ramp flips per theme and every existing class stays
         * correct in both. The values, the duty each step owes and the measured
         * ratios are in `globals.css`; the light values are:
         *
         *   50  #f7f3e8 ★ Warm Cream — page ground
         *   200 #e6e2d7 ★ Warm Grey  — decorative divider / card edge
         *   300 #8f8b7f   3.07:1     — CONTROL border (SC 1.4.11)
         *   400 #716e64   4.60:1     — placeholder text, decorative icons
         *   500 #5d5a52   6.21:1     — SECONDARY TEXT
         *   900 #242824 ★ Charcoal   — body text, 13.49:1
         *   950 #000000 ★ FleetWise Black
         */
        sand: {
          50: "rgb(var(--sand-50) / <alpha-value>)",
          100: "rgb(var(--sand-100) / <alpha-value>)",
          200: "rgb(var(--sand-200) / <alpha-value>)",
          300: "rgb(var(--sand-300) / <alpha-value>)",
          400: "rgb(var(--sand-400) / <alpha-value>)",
          500: "rgb(var(--sand-500) / <alpha-value>)",
          600: "rgb(var(--sand-600) / <alpha-value>)",
          700: "rgb(var(--sand-700) / <alpha-value>)",
          800: "rgb(var(--sand-800) / <alpha-value>)",
          900: "rgb(var(--sand-900) / <alpha-value>)",
          950: "rgb(var(--sand-950) / <alpha-value>)",
        },
        // ── Traffic-light service statuses (Scope §4.3). All AA as text on
        //    cream AND on white. `ok`/`due` are drawn from the brand itself.
        status: {
          // Variable-driven so the traffic light survives a theme change. On
          // cream: ok 7.89:1, due 5.14:1, overdue 6.03:1. The same fixed hexes
          // on a dark card are 1.63 / 2.50 / 2.13 — which is what put the
          // required-field asterisk, every "Delete" and money shown in red or
          // green below AA once dark mode existed. Values in globals.css.
          ok: "rgb(var(--status-ok) / <alpha-value>)",
          due: "rgb(var(--status-due) / <alpha-value>)",
          overdue: "rgb(var(--status-overdue) / <alpha-value>)",

          // `warn` and `bad` are the same two colours under the names the
          // financial screens reach for — a caution ("you have billed more than
          // you quoted", "no receipt on file", negative cash) and a failure
          // ("this email did not send").
          //
          // They were used 19 times across 13 files and DEFINED NOWHERE, in any
          // version of this config. Tailwind emits nothing for an unknown token,
          // so every one of those cells has been rendering as ordinary body text
          // — including the 60-day column of the debtors ageing, which exists
          // precisely to say "this is getting late". `design_lint` now fails on
          // a status token that has no definition, so it cannot recur.
          warn: "rgb(var(--status-due) / <alpha-value>)",
          bad: "rgb(var(--status-overdue) / <alpha-value>)",
        },
        /**
         * The destructive SOLID — a filled danger button.
         *
         * It needs its own pair because the text has to flip WITH the fill:
         * white on the deep red (6.68:1) in light, black on the light red
         * (6.34:1) in dark. Keeping `text-white` would have been 1.92:1 the
         * moment the fill lightened.
         */
        dangerSolid: {
          DEFAULT: "rgb(var(--danger-solid) / <alpha-value>)",
          hover: "rgb(var(--danger-solid-hover) / <alpha-value>)",
          ink: "rgb(var(--danger-solid-ink) / <alpha-value>)",
        },
        // ── Danger: the shade family of the functional red above, so an error
        //    callout, a destructive button and an overdue badge are visibly the
        //    same idea. This is NOT a second accent — it is the one functional
        //    colour the palette does not supply, used only for overdue, fault
        //    and destructive states, never as chrome. See docs/DESIGN.md §4.
        danger: {
          50: "#fcecec",
          100: "#f8dcdb",
          200: "#eeb0af",
          300: "#d06d6c",
          400: "#c2403f",
          500: "#b3201f",
          600: "#9e1c1b", //  white on this = 7.4:1
          700: "#8f1a19", //  6.98:1 on danger-100
          800: "#6b1312",
          900: "#4a0d0c",
          950: "#2e0808",
        },
        // ── Callout tones. One place that fixes the tint/border/text triple for
        //    Flash, banners and inline notices, each verified: text clears 4.5:1
        //    on its own tint, and the tint is distinguishable from BOTH the cream
        //    page ground and a white card. Tone is never carried by colour alone —
        //    every callout also has its own icon and words.
        callout: {
          "danger-bg": "rgb(var(--callout-danger-bg) / <alpha-value>)",
          "danger-edge": "rgb(var(--callout-danger-edge) / <alpha-value>)",
          "danger-ink": "rgb(var(--callout-danger-ink) / <alpha-value>)",
          "warn-bg": "rgb(var(--callout-warn-bg) / <alpha-value>)",
          "warn-edge": "rgb(var(--callout-warn-edge) / <alpha-value>)",
          "warn-ink": "rgb(var(--callout-warn-ink) / <alpha-value>)",
          "ok-bg": "rgb(var(--callout-ok-bg) / <alpha-value>)",
          "ok-edge": "rgb(var(--callout-ok-edge) / <alpha-value>)",
          "ok-ink": "rgb(var(--callout-ok-ink) / <alpha-value>)",
          "info-bg": "rgb(var(--callout-info-bg) / <alpha-value>)",
          "info-edge": "rgb(var(--callout-info-edge) / <alpha-value>)",
          "info-ink": "rgb(var(--callout-info-ink) / <alpha-value>)",
        },
        // ── Semantic surface aliases, resolved from the CSS custom properties
        //    in globals.css. These are what make the dark theme a token swap
        //    rather than a rewrite: `bg-surface` is correct in both themes.
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          raised: "rgb(var(--surface-raised) / <alpha-value>)",
          sunken: "rgb(var(--surface-sunken) / <alpha-value>)",
          /** Row hover. Sinks on cream, lifts on charcoal - see globals.css. */
          hover: "rgb(var(--row-hover) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          muted: "rgb(var(--ink-muted) / <alpha-value>)",
          subtle: "rgb(var(--ink-subtle) / <alpha-value>)",
        },
        edge: {
          DEFAULT: "rgb(var(--edge) / <alpha-value>)",
          soft: "rgb(var(--edge-soft) / <alpha-value>)",
        },
        // ── The gold accent, as tokens rather than fixed steps ────────────
        //    `gold-*` above is hardcoded hex and cannot follow the theme, while
        //    `sand-*` inverts. Combining the two put near-white text on a
        //    near-white ground (1.02:1) on the selected nav row, and white on
        //    gold (2.12:1) on every accent button, in dark mode. Use these
        //    wherever gold has to stay legible in BOTH themes.
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          ink: "rgb(var(--accent-ink) / <alpha-value>)",
          tint: "rgb(var(--accent-tint) / <alpha-value>)",
          rim: "rgb(var(--accent-rim) / <alpha-value>)",
          "on-fill": "rgb(var(--accent-on-fill) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          '"Helvetica Neue"',
          "Arial",
          '"Noto Sans"',
          "sans-serif",
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
        ],
      },
      /**
       * One type scale, seven steps. Before this there were 32 distinct sizes
       * in use, 24 of them arbitrary `text-[1.05rem]`-style one-offs — four of
       * which sat within 0.15rem of each other, a difference the eye cannot
       * resolve but which makes consistent vertical rhythm impossible.
       *
       * Line heights are paired with each size so a heading never needs a
       * second class to look right.
       */
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.01em" }],
        xs: ["0.75rem", { lineHeight: "1.125rem" }],
        sm: ["0.875rem", { lineHeight: "1.375rem" }],
        base: ["1rem", { lineHeight: "1.5rem" }],
        lg: ["1.125rem", { lineHeight: "1.625rem", letterSpacing: "-0.005em" }],
        xl: ["1.3125rem", { lineHeight: "1.75rem", letterSpacing: "-0.01em" }],
        "2xl": ["1.625rem", { lineHeight: "2rem", letterSpacing: "-0.015em" }],
        "3xl": ["2.0625rem", { lineHeight: "2.375rem", letterSpacing: "-0.02em" }],
        "4xl": ["2.625rem", { lineHeight: "2.875rem", letterSpacing: "-0.025em" }],
      },
      boxShadow: {
        // Warm-tinted, layered. Tinted with the charcoal rather than pure black
        // so shadows sit in the same colour world as the cream ground.
        // Driven by CSS vars so the dark theme can change OPACITY as well as
        // hue: a charcoal shadow at 5% is invisible on a charcoal surface, which
        // is what --surface is in dark (29 33 29).
        xs: "var(--shadow-xs)",
        card: "var(--shadow-card)",
        soft: "var(--shadow-soft)",
        pop: "var(--shadow-pop)",
        // Gold focus/selected glow — the accent used as emphasis, not as text.
        gold: "0 0 0 3px rgb(234 165 12 / 0.28)",
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.15s ease-out",
        "slide-up": "slide-up 0.24s cubic-bezier(0.32, 0.72, 0, 1)",
        "scale-in": "scale-in 0.16s ease-out",
        "rise-in": "rise-in 0.22s cubic-bezier(0.32, 0.72, 0, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
