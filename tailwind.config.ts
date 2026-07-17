import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Traffic-light service statuses used across the app (Scope §4.3).
        status: {
          ok: "#16a34a",       // green  — OK
          due: "#d97706",      // amber  — due soon
          overdue: "#dc2626",  // red    — overdue
        },
      },
    },
  },
  plugins: [],
};

export default config;
