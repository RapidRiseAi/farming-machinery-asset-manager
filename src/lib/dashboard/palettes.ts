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

/** More slices than colours fold into "Other" upstream; past the end we never invent a hue. */
export function slotColour(palette: PaletteKey, index: number): Swatch {
  const set = PALETTES[palette];
  return set[Math.min(index, set.length - 1)];
}

/** The style that hands a swatch to `.viz-c`. */
export function swatchStyle(s: Swatch): Record<string, string> {
  return { "--c-l": s.light, "--c-d": s.dark };
}
