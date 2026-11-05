/**
 * The dashboard grid: twelve columns on a laptop, rows of fixed height, widgets as boxes.
 *
 * Pure functions, no React, so the rules can be tested: a box never overlaps another,
 * nothing floats with a gap above it (vertical gravity, the way a person stacks cards),
 * and every size stays inside its widget's limits. The grid component calls `place`
 * on every pointer move while dragging, with the dragged box pinned so the others make
 * room around it, then `compact` once on drop so the dropped box settles too.
 */

export const GRID_COLS = 12;
/** Far past any real board; a bound so a hand-made layout cannot ask for a mile of rows. */
export const MAX_ROW = 400;
export const MAX_WIDGETS = 40;

export type GridBox = { x: number; y: number; w: number; h: number };
export type WidgetSettings = Record<string, string>;
export type LayoutItem = GridBox & { id: string; type: string; settings: WidgetSettings };
export type SizeLimits = { minW: number; minH: number; maxW: number; maxH: number };

export function collides(a: GridBox, b: GridBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const int = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));

/** Inside the grid and inside the widget's own limits. */
export function clampBox(box: GridBox, limits: SizeLimits, cols = GRID_COLS): GridBox {
  const w = int(box.w, limits.minW, Math.min(limits.maxW, cols));
  const h = int(box.h, limits.minH, limits.maxH);
  return { x: int(box.x, 0, cols - w), y: int(box.y, 0, MAX_ROW), w, h };
}

/** Reading order: top to bottom, then left to right. The phone shows the board in it. */
export function readingOrder<T extends GridBox>(items: T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Vertical gravity. Each box rises as far as it can, in reading order; one that would
 * overlap a box already settled moves down until it is clear. A `pinned` box keeps its
 * place exactly and everything else arranges around it.
 */
export function compact(items: LayoutItem[], pinnedId?: string): LayoutItem[] {
  const pinned = pinnedId ? items.find((i) => i.id === pinnedId) : undefined;
  const settled: LayoutItem[] = pinned ? [pinned] : [];
  for (const item of readingOrder(items.filter((i) => i !== pinned))) {
    let y = item.y;
    while (y > 0 && !settled.some((s) => collides({ ...item, y: y - 1 }, s))) y--;
    while (settled.some((s) => collides({ ...item, y }, s))) y++;
    settled.push({ ...item, y });
  }
  return readingOrder(settled);
}

/**
 * Put one box somewhere (a move, a resize, or both) and let the rest make room. The box
 * stays pinned where it was put; call `compact` afterwards to let it settle.
 */
export function place(
  items: LayoutItem[],
  id: string,
  box: Partial<GridBox>,
  limits: SizeLimits,
  cols = GRID_COLS,
): LayoutItem[] {
  const current = items.find((i) => i.id === id);
  if (!current) return items;
  const next = { ...current, ...clampBox({ ...current, ...box }, limits, cols) };
  return compact(items.map((i) => (i.id === id ? next : i)), id);
}

/**
 * A new widget takes the first gap it fits, reading top to bottom and left to right, so
 * a space beside a narrower widget is filled before the board grows longer.
 */
export function addItem(items: LayoutItem[], item: Omit<LayoutItem, "x" | "y">, limits: SizeLimits, cols = GRID_COLS): LayoutItem[] {
  const size = clampBox({ x: 0, y: 0, w: item.w, h: item.h }, limits, cols);
  const bottom = items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + size.w <= cols; x++) {
      const box = { ...size, x, y };
      if (!items.some((i) => collides(box, i))) return compact([...items, { ...item, ...box }]);
    }
  }
  return compact([...items, { ...item, ...size, x: 0, y: bottom }]);
}

export function removeItem(items: LayoutItem[], id: string): LayoutItem[] {
  return compact(items.filter((i) => i.id !== id));
}

/**
 * One step earlier or later in reading order, for the phone and for a keyboard: the box
 * takes its neighbour's position and the neighbour moves out of its way.
 */
export function shiftInOrder(items: LayoutItem[], id: string, step: -1 | 1, limitsOf: (type: string) => SizeLimits): LayoutItem[] {
  const order = readingOrder(items);
  const at = order.findIndex((i) => i.id === id);
  const other = order[at + step];
  if (at < 0 || !other) return items;
  const me = order[at];
  const moved = place(items, me.id, { x: other.x, y: step < 0 ? other.y : other.y + other.h - 1 }, limitsOf(me.type));
  return compact(moved);
}

/** A short unique id for a new widget; never reused within one board. */
export function newWidgetId(items: LayoutItem[], type: string): string {
  const base = type.replace(/[^a-z0-9]/g, "").slice(0, 24) || "w";
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!items.some((i) => i.id === id)) return id;
  }
}
