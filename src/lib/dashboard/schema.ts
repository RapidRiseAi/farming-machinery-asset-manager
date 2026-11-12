/**
 * What a saved board may contain. A layout arrives from the browser (every drag saves
 * one) and from the database; both are cleaned here the same way before anything uses
 * them: unknown widgets dropped, sizes held to their limits, settings held to their
 * choices, overlaps settled. A layout that is not a layout at all is null, and the
 * caller falls back to the default board.
 */
import { z } from "zod";
import { MAX_WIDGETS, clampBox, compact, type LayoutItem, type WidgetSettings } from "./layout";
import { TITLE_MAX, WIDGET_BY_TYPE } from "./widgets";
import { isHex } from "./palettes";

const LAYOUT_VERSION = 1;

const itemSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  type: z.string().max(40),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  settings: z.record(z.string().max(30), z.string().max(200)).optional(),
});

const layoutSchema = z.object({
  version: z.literal(LAYOUT_VERSION),
  items: z.array(z.unknown()).max(MAX_WIDGETS * 2),
});

export type StoredLayout = { version: typeof LAYOUT_VERSION; items: LayoutItem[] };

/** Only the settings the widget offers, each one of its choices; a short plain title. */
export function cleanSettings(type: string, raw: Record<string, string> | undefined): WidgetSettings {
  const def = WIDGET_BY_TYPE.get(type);
  const out: WidgetSettings = {};
  if (!def || !raw) return out;
  for (const [key, opt] of Object.entries(def.options)) {
    const v = raw[key];
    if (v === undefined || v === opt.default) continue;
    if (opt.choices.includes(v) || (opt.custom && isHex(v))) out[key] = opt.custom && isHex(v) ? v.toLowerCase() : v;
  }
  // A colour per slice, only for the slices the widget draws.
  for (const seg of def.segments ?? []) {
    const v = raw[`c.${seg.key}`];
    if (isHex(v)) out[`c.${seg.key}`] = v.toLowerCase();
  }
  const title = (raw.title ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  if (title) out.title = title;
  return out;
}

export function normalizeLayout(raw: unknown): LayoutItem[] | null {
  const parsed = layoutSchema.safeParse(raw);
  if (!parsed.success) return null;
  const seen = new Set<string>();
  const items: LayoutItem[] = [];
  for (const candidate of parsed.data.items) {
    const r = itemSchema.safeParse(candidate);
    if (!r.success) continue;
    const def = WIDGET_BY_TYPE.get(r.data.type);
    if (!def || seen.has(r.data.id)) continue;
    seen.add(r.data.id);
    items.push({
      id: r.data.id,
      type: r.data.type,
      ...clampBox(r.data, def.limits),
      settings: cleanSettings(r.data.type, r.data.settings),
    });
    if (items.length === MAX_WIDGETS) break;
  }
  return compact(items);
}

export function storedLayout(items: LayoutItem[]): StoredLayout {
  return { version: LAYOUT_VERSION, items };
}
