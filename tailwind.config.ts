import type { Config } from "tailwindcss";

/**
 * FarmGear design tokens.
 *
 * Light-theme baseline (Scope §7 — mid-range Android, low bandwidth). No web
 * font: a system stack keeps the bundle lean. Palette is a professional,
 * agricultural green ("brand") over a warm stone neutral ("sand"), plus the
 * traffic-light service tokens (Scope §4.3) — refined to hues that all clear
 * WCAG-AA (>=4.5:1) as text on white.
 */
const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Brand — deep agricultural green. 600 = primary action (5.0:1 on
        // white), 700 = deep/hover & headings (7.1:1).
        brand: {
          50: "#f1f8f2",
          100: "#dcefdf",
          200: "#bbdfc2",
          300: "#8fc89d",
          400: "#5aa971",
          500: "#2f8b4e",
          600: "#15803d",
          700: "#166534",
          800: "#14532b",
          900: "#123f23",
          950: "#082915",
        },
        // Sand — warm neutral (stone-like). Body text = 900, secondary = 600,
        // borders = 200, page background = 50.
        sand: {
          50: "#faf9f7",
          100: "#f4f2ed",
          200: "#e9e5dd",
          300: "#d8d2c7",
          400: "#b3ab9d",
          500: "#8a8173",
          600: "#6b6356",
          700: "#514a3f",
          800: "#383229",
          900: "#26221c",
          950: "#16130e",
        },
        // Traffic-light service statuses (Scope §4.3) — all AA as text on white.
        status: {
          ok: "#15803d", // green  — OK        (5.0:1)
          due: "#b45309", // amber  — due soon (5.0:1)
          overdue: "#dc2626", // red — overdue (4.8:1)
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
      boxShadow: {
        // Soft, layered, warm-tinted shadows.
        xs: "0 1px 2px 0 rgb(16 24 20 / 0.04)",
        card: "0 1px 2px 0 rgb(16 24 20 / 0.05), 0 1px 3px 0 rgb(16 24 20 / 0.06)",
        soft: "0 2px 8px -2px rgb(16 24 20 / 0.08), 0 6px 20px -6px rgb(16 24 20 / 0.10)",
        pop: "0 10px 30px -8px rgb(16 24 20 / 0.18), 0 4px 10px -4px rgb(16 24 20 / 0.10)",
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
      },
      animation: {
        "fade-in": "fade-in 0.15s ease-out",
        "slide-up": "slide-up 0.24s cubic-bezier(0.32, 0.72, 0, 1)",
        "scale-in": "scale-in 0.16s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
