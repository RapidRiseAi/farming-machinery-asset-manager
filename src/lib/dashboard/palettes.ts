/**
 * Chart colours for the dashboard, one light and one dark step per slot.
 *
 * Every set here was run through the data-viz validator (OKLCH lightness band, chroma
 * floor, colour-blind separation of neighbours, normal-vision floor, 3:1 against the
 * card) for BOTH themes, against the card surfaces the charts sit on: white in light,
 * #1d211d in dark. The ORDER is part of the result: green and orange next to each
 * other failed for red-green colour blindness, so blue sits between them. Do not
 * reorder or add a colour without re-running it; `palettes.test.ts` guards contrast.
 *
 * Colours reach a mark as two CSS variables (`--c-l`, `--c-d`) and the `.viz-c` class
 * picks one by theme (globals.css), because charts render on the server and the theme
 * switches in the browser.
 */

export type Hex = `#${string}`;
export type Swatch = { light: Hex; dark: Hex };

/** The named colours a single-series chart or a number can wear, in palette order. */
export const HUES = {
  green: { light: "#2a8a5f", dark: "#3a9a6c" },
  blue: { light: "#2a78d6", dark: "#3987e5" },
  orange: { light: "#eb6834", dark: "#d95926" },
  violet: { light: "#6250d6", dark: "#9085e9" },
  gold: { light: "#c98500", dark: "#c98500" },
  rose: { light: "#d55181", dark: "#d55181" },
  // Single colours a person may pick for a widget (3.9:1 to 6.3:1 against the card in both
  // themes, checked by palettes' contrast test). Not in the categorical sets: a chart with
  // several series keeps the validated order above.
  teal: { light: "#0f8584", dark: "#1fa3a1" },
  red: { light: "#d63a3a", dark: "#e66767" },
  slate: { light: "#5f6f84", dark: "#8a9ab0" },
  olive: { light: "#6f8a1f", dark: "#8fab3c" },
  brown: { light: "#9c6a3a", dark: "#b8885a" },
} as const satisfies Record<string, Swatch>;
export type HueKey = keyof typeof HUES;
export const HUE_KEYS = Object.keys(HUES) as HueKey[];

/** Categorical sets for charts with several series or slices. Fixed order, never cycled. */
export const PALETTES = {
  fleetwise: [HUES.green, HUES.blue, HUES.orange, HUES.violet, HUES.gold, HUES.rose],
  // The data-viz reference set (validated by its authors in both themes, first six slots).
  classic: [
    { light: "#2a78d6", dark: "#3987e5" },
    { light: "#eb6834", dark: "#d95926" },
    { light: "#1baf7a", dark: "#199e70" },
    { light: "#eda100", dark: "#c98500" },
    { light: "#e87ba4", dark: "#d55181" },
    { light: "#008300", dark: "#008300" },
  ],
} as const satisfies Record<string, readonly Swatch[]>;
export type PaletteKey = keyof typeof PALETTES;
export const PALETTE_KEYS = Object.keys(PALETTES) as PaletteKey[];

/**
 * State colours, reserved for state and never a "series 4". A status chart always shows
 * the state's NAME beside its colour, so identity is never colour alone.
 */
export const STATUS = {
  ok: { light: "#2a8a5f", dark: "#3a9a6c" },
  warn: { light: "#c98500", dark: "#c98500" },
  bad: { light: "#e34948", dark: "#e66767" },
  neutral: { light: "#8f8b7f", dark: "#8f8b7f" },
} as const satisfies Record<string, Swatch>;
export type StatusKey = keyof typeof STATUS;

/**
 * More colours to pick from, beyond the named hues: one step each, chosen to stay 3:1
 * against the card in BOTH themes (palettes test). A preset is stored as its hex, like a
 * colour picked on the wheel.
 */
export const PRESETS: Hex[] = [
  "#1281c4", "#0f8ca3", "#18907a", "#14875a", "#2f7d3b", "#5f8a12", "#a88a10", "#b5740c",
  "#a65a2e", "#d4573d", "#c43350", "#c4479a", "#b8399e", "#9d5a98", "#8b50d0", "#5c67dd",
  "#4a6cbf", "#2d6fb8", "#5a7287", "#6b7383",
];

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v: string | undefined | null): v is Hex => !!v && HEX.test(v);

/** A colour setting as a swatch: a named hue (its own dark step) or a hex (both themes). */
export function swatchOf(value: string | undefined | null): Swatch | null {
  if (!value) return null;
  if (value in HUES) return HUES[value as HueKey];
  return isHex(value) ? { light: value, dark: value } : null;
}

/** WCAG contrast of a hex against another, for warning when a picked colour will not show. */
export function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** The card surfaces charts sit on (light, dark), for those warnings. */
export const CARD_SURFACES = { light: "#ffffff", dark: "#1d211d" } as const;

/** More slices than colours fold into "Other" upstream; past the end we never invent a hue. */
export function slotColour(palette: PaletteKey, index: number): Swatch {
  const set = PALETTES[palette];
  return set[Math.min(index, set.length - 1)];
}

/** The style that hands a swatch to `.viz-c`. */
export function swatchStyle(s: Swatch): Record<string, string> {
  return { "--c-l": s.light, "--c-d": s.dark };
}
