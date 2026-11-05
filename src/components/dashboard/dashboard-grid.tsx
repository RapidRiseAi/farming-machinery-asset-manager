"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type CSSProperties, type ReactNode } from "react";

import { t, type Lang } from "@/lib/i18n";
import {
  GRID_COLS, addItem, compact, newWidgetId, place, readingOrder, reflow, removeItem, shiftInOrder,
  type LayoutItem, type SizeLimits, type WidgetSettings,
} from "@/lib/dashboard/layout";
import { CATEGORIES, SIZE_PRESETS, TITLE_MAX, WIDGET_BY_TYPE, type WidgetCategory } from "@/lib/dashboard/widgets";
import { HUES, swatchStyle, type HueKey } from "@/lib/dashboard/palettes";
import { sampleData } from "@/lib/dashboard/samples";
import { Button } from "@/components/ui/button";
import { TONES, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { Modal } from "@/components/ui/dialog";
import {
  ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, CloseIcon, GripIcon, LockIcon, PlusIcon, ResizeIcon, SearchIcon, SettingsIcon,
} from "@/components/ui/icons";
import { CATEGORY_LOOK, WidgetBody } from "./widget-body";

/** One grid row on a laptop, and the gap between widgets (gap-4). */
const ROW_PX = 72;
const GAP_PX = 16;
/** How long a finger rests on a widget before it lifts, as on a phone's home screen. */
const HOLD_MS = 350;
/** Movement that turns a mouse press into a drag, and cancels a pending touch hold. */
const DRAG_SLOP = 6;
const NEW_ID = "__new";

export type CatalogEntry = {
  type: string;
  category: WidgetCategory;
  /** Why it cannot be added here, already translated, or null. */
  blocked: string | null;
};

export type WidgetFrameInfo = {
  title: string;
  href: string;
  /** Translated reason when the widget cannot show for this person or farm. */
  locked?: string;
};

export type SaveResult = { ok: true } | { ok: false };

/** The page header's "Customise" button tells the grid to start editing. */
const EDIT_EVENT = "fleetwise:dashboard-edit";

export function CustomiseButton({ locale }: { locale: Lang }) {
  return (
    <Button variant="secondary" onClick={() => window.dispatchEvent(new Event(EDIT_EVENT))}>
      <SettingsIcon className="text-lg" />
      {t("dash.customise", locale)}
    </Button>
  );
}

const limitsOf = (type: string): SizeLimits =>
  WIDGET_BY_TYPE.get(type)?.limits ?? { minW: 2, minH: 2, maxW: GRID_COLS, maxH: 8 };

/** A widget lifted off the board or out of the tray, following the pointer. */
type Drag = {
  source: "board" | "tray";
  id: string;
  type: string;
  /** Where in the ghost the pointer holds it, and the ghost's size, in pixels. */
  grabX: number; grabY: number; wPx: number; hPx: number;
  x: number; y: number;
  base: LayoutItem[];
  /** Grid size a tray widget takes when dropped. */
  w: number; h: number;
};
type Resize = { id: string; edge: "r" | "b" | "rb"; startX: number; startY: number; w: number; h: number; base: LayoutItem[] };

/**
 * The customisable board.
 *
 * The page renders each widget's body on the server and hands them in as `contents`;
 * this component owns the arrangement: where each widget sits, how big it is, which are
 * on the board, and their settings. Every change saves the whole board (`save`), cleaned
 * again on the server; adding a widget or changing its settings also refreshes the page,
 * which renders the new bodies.
 *
 * The mechanics are a phone home screen's: in edit mode a widget lifts and follows the
 * pointer (a press and hold on a touch screen) while a dashed outline shows where it will
 * land and the others make room; its right edge, bottom edge and corner resize it; the
 * widget tray holds live previews that are dragged onto the board or added with a tap.
 * On a laptop the board is a 12-column grid at saved positions; on a phone it is one
 * reading order (numbers two to a row) and dragging reorders it. A keyboard moves a widget
 * with arrows on its handle and resizes with Shift and arrows.
 */
export function DashboardGrid({
  initial, defaults, contents, frames, catalog, canEdit, save, locale,
}: {
  initial: LayoutItem[];
  defaults: LayoutItem[];
  contents: Record<string, ReactNode>;
  frames: Record<string, WidgetFrameInfo>;
  catalog: CatalogEntry[];
  canEdit: boolean;
  save: (items: LayoutItem[]) => Promise<SaveResult>;
  locale: Lang;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [preview, setPreviewState] = useState<LayoutItem[] | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const [resizing, setResizing] = useState<Resize | null>(null);
  const [editing, setEditing] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [announce, setAnnounce] = useState("");
  const [trayOpen, setTrayOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [, startRefresh] = useTransition();
  const gridRef = useRef<HTMLDivElement>(null);
  const saveSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The drag and its landing are read by native event handlers between renders, so they
  // live in refs as well as state (state draws them, refs answer the handlers).
  const dragRef = useRef<Drag | null>(null);
  const previewRef = useRef<LayoutItem[] | null>(null);
  const setDrag = (d: Drag | null) => { dragRef.current = d; setDragState(d); };
  const setPreview = (p: LayoutItem[] | null) => { previewRef.current = p; setPreviewState(p); };

  useEffect(() => {
    if (!canEdit) return;
    const start = () => setEditing(true);
    window.addEventListener(EDIT_EVENT, start);
    return () => window.removeEventListener(EDIT_EVENT, start);
  }, [canEdit]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setDesktop(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const title = useCallback(
    (item: { type: string; id: string; settings?: WidgetSettings }) =>
      item.settings?.title || frames[item.id]?.title || t(`dash.w.${item.type}.title`, locale),
    [frames, locale],
  );

  // == Saving =====================================================================
  const persist = useCallback(async (next: LayoutItem[], refresh: boolean) => {
    const seq = ++saveSeq.current;
    setStatus("saving");
    let ok = false;
    try {
      ok = (await save(next)).ok;
    } catch {
      ok = false;
    }
    if (seq !== saveSeq.current) return; // a later save is in flight; it reports
    setStatus(ok ? "saved" : "error");
    if (ok && refresh) startRefresh(() => router.refresh());
  }, [save, router]);

  /** Commit a new board: show it now, save it (soon, for a stream of moves). */
  const commit = useCallback((next: LayoutItem[], opts: { refresh?: boolean; debounce?: boolean } = {}) => {
    setItems(next);
    if (timer.current) clearTimeout(timer.current);
    if (opts.debounce) timer.current = setTimeout(() => void persist(next, false), 600);
    else void persist(next, !!opts.refresh);
  }, [persist]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const say = (i: LayoutItem) =>
    setAnnounce(t("dash.moved", locale).replace("{title}", title(i)).replace("{x}", String(i.x + 1)).replace("{y}", String(i.y + 1))
      .replace("{w}", String(i.w)).replace("{h}", String(i.h)));

  // == Geometry ===================================================================
  const steps = () => {
    const rect = gridRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 1200;
    return { rect, x: (width + GAP_PX) / GRID_COLS, y: ROW_PX + GAP_PX };
  };

  /** Where a lifted widget would land: the board with it (as a placeholder) placed. */
  const landing = (d: Drag): LayoutItem[] | null => {
    const s = steps();
    const rect = s.rect;
    if (!rect || !gridRef.current) return null;
    const base = d.source === "tray"
      ? [...d.base, { id: NEW_ID, type: d.type, x: 0, y: 9999, w: d.w, h: d.h, settings: {} }]
      : d.base;
    const over = d.x >= rect.left - 24 && d.x <= rect.right + 24 && d.y >= rect.top - 24 && d.y <= rect.bottom + ROW_PX * 3;
    if (d.source === "tray" && !over) return null;
    if (desktop) {
      const left = d.x - d.grabX - rect.left;
      const top = d.y - d.grabY - rect.top;
      return place(base, d.id, { x: Math.round(left / s.x), y: Math.max(0, Math.round(top / s.y)) }, limitsOf(d.type));
    }
    // Phone: the slot in reading order the pointer is over.
    const others = readingOrder(base.filter((i) => i.id !== d.id));
    const els = new Map([...gridRef.current.querySelectorAll<HTMLElement>("[data-widget-id]")].map((el) => [el.dataset.widgetId!, el]));
    let index = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = els.get(others[i].id)?.getBoundingClientRect();
      if (r && (d.y < r.top + r.height / 2 || (d.y < r.bottom && d.x < r.left + r.width / 2))) { index = i; break; }
    }
    const me = base.find((i) => i.id === d.id)!;
    return reflow([...others.slice(0, index), me, ...others.slice(index)], limitsOf);
  };

  // == Lifting, carrying, dropping ================================================
  const lift = (el: HTMLElement, x: number, y: number) => {
    const source = el.dataset.dragSource as "board" | "tray";
    const type = el.dataset.widgetType!;
    const def = WIDGET_BY_TYPE.get(type);
    if (!def) return;
    const r = el.getBoundingClientRect();
    if (source === "board") {
      setDrag({ source, id: el.dataset.widgetId!, type, grabX: x - r.left, grabY: y - r.top, wPx: r.width, hPx: r.height, x, y, base: items, w: def.size.w, h: def.size.h });
      setPreview(items);
    } else {
      // A widget from the tray takes the size it will have on the board.
      const s = steps();
      const wPx = desktop ? def.size.w * s.x - GAP_PX : Math.min(window.innerWidth - 32, 360);
      const hPx = desktop ? def.size.h * ROW_PX + (def.size.h - 1) * GAP_PX : Math.min(def.size.h, 4) * ROW_PX;
      const d: Drag = { source, id: NEW_ID, type, grabX: Math.min(wPx / 2, 140), grabY: 28, wPx, hPx, x, y, base: items, w: def.size.w, h: def.size.h };
      setDrag(d);
      setPreview(landing(d));
      if (!desktop) setTrayOpen(false);
    }
    if ("vibrate" in navigator) navigator.vibrate?.(12);
  };

  const follow = (x: number, y: number) => {
    const d = dragRef.current;
    if (!d) return;
    // Keep the page scrolling when a widget is carried past the top or bottom edge.
    if (y > window.innerHeight - 56) window.scrollBy(0, 16);
    else if (y < 80) window.scrollBy(0, -16);
    const next = { ...d, x, y };
    setDrag(next);
    setPreview(landing(next));
  };

  const drop = (cancel: boolean) => {
    const d = dragRef.current;
    // Nothing lifted: leave the preview alone. Every mouse release reaches here, a resize's
    // too, and clearing the preview first undid the resize before it could be saved.
    if (!d) return;
    const p = previewRef.current;
    setDrag(null);
    setPreview(null);
    if (cancel || !p) return;
    if (d.source === "tray") {
      const id = newWidgetId(items, d.type);
      const added = compact(p.map((i) => (i.id === NEW_ID ? { ...i, id } : i)));
      commit(added, { refresh: true });
      const placed = added.find((i) => i.id === id);
      if (placed) say(placed);
      return;
    }
    const settled = compact(p);
    const moved = settled.find((i) => i.id === d.id)!;
    const before = d.base.find((i) => i.id === d.id)!;
    const reordered = readingOrder(settled).map((i) => i.id).join() !== readingOrder(d.base).map((i) => i.id).join();
    if (moved.x !== before.x || moved.y !== before.y || reordered) {
      commit(settled, { debounce: true });
      say(moved);
    }
  };

  // The handlers native listeners call, always the latest (they close over the board).
  const live = useRef({ lift, follow, drop });
  live.current = { lift, follow, drop };

  // Mouse and pen: press, move past the slop, carry; release drops.
  const pending = useRef<{ el: HTMLElement; x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!editing || e.pointerType === "touch" || e.button !== 0) return;
    if ((e.target as Element).closest("button, a, input, select, textarea, [data-no-drag]")) return;
    pending.current = { el: e.currentTarget, x: e.clientX, y: e.clientY };
  };
  useEffect(() => {
    if (!editing) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const p = pending.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_SLOP) {
        pending.current = null;
        live.current.lift(p.el, p.x, p.y);
      }
      live.current.follow(e.clientX, e.clientY);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      pending.current = null;
      live.current.drop(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") live.current.drop(true); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  }, [editing]);

  // Touch: press and hold lifts; a move before the hold is a scroll, as on a phone.
  // Native listeners, because React's touchmove is passive and could not stop the scroll.
  useEffect(() => {
    if (!editing) return;
    let hold: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;
    const clear = () => { if (hold) clearTimeout(hold); hold = null; start = null; };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const target = e.target as Element;
      const el = target.closest<HTMLElement>("[data-drag-source]");
      if (!el || target.closest("button, a, input, select, textarea, [data-no-drag]")) return;
      const touch = e.touches[0];
      start = { x: touch.clientX, y: touch.clientY };
      hold = setTimeout(() => { if (start) live.current.lift(el, start.x, start.y); hold = null; }, HOLD_MS);
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (dragRef.current) {
        e.preventDefault();
        live.current.follow(touch.clientX, touch.clientY);
        return;
      }
      if (start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > DRAG_SLOP * 1.5) clear();
    };
    const onEnd = () => { clear(); if (dragRef.current) live.current.drop(false); };
    const onCancel = () => { clear(); if (dragRef.current) live.current.drop(true); };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onCancel);
    return () => {
      clear();
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
    };
  }, [editing]);

  // == Resizing (laptop) ==========================================================
  const startResize = (e: React.PointerEvent, item: LayoutItem, edge: Resize["edge"]) => {
    if (!editing || !desktop || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setResizing({ id: item.id, edge, startX: e.clientX, startY: e.clientY, w: item.w, h: item.h, base: items });
    setPreview(items);
  };
  const resizeLive = useRef({ commit, say });
  resizeLive.current = { commit, say };
  useEffect(() => {
    if (!resizing) return;
    const move = (e: PointerEvent) => {
      const s = steps();
      const dw = resizing.edge === "b" ? 0 : Math.round((e.clientX - resizing.startX) / s.x);
      const dh = resizing.edge === "r" ? 0 : Math.round((e.clientY - resizing.startY) / s.y);
      const item = resizing.base.find((i) => i.id === resizing.id)!;
      setPreview(place(resizing.base, resizing.id, { w: resizing.w + dw, h: resizing.h + dh }, limitsOf(item.type)));
    };
    const up = () => {
      const p = previewRef.current;
      setPreview(null);
      setResizing(null);
      if (!p) return;
      const settled = compact(p);
      const after = settled.find((i) => i.id === resizing.id)!;
      if (after.w !== resizing.w || after.h !== resizing.h) {
        resizeLive.current.commit(settled, { debounce: true });
        resizeLive.current.say(after);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [resizing]);

  // == Keyboard on the handles ====================================================
  const onHandleKey = (e: React.KeyboardEvent, item: LayoutItem, resizeOnly = false) => {
    const k = e.key;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(k)) return;
    e.preventDefault();
    const dx = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0;
    const dy = k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0;
    const resize = resizeOnly || e.shiftKey;
    const box = resize ? { w: item.w + dx, h: item.h + dy } : { x: item.x + dx, y: item.y + dy };
    // Up or down past a neighbour swaps with it; gravity would otherwise put it back.
    const next = !resize && dy !== 0 && dx === 0
      ? shiftInOrder(items, item.id, dy as -1 | 1, limitsOf)
      : compact(place(items, item.id, box, limitsOf(item.type)));
    commit(next, { debounce: true });
    const moved = next.find((i) => i.id === item.id);
    if (moved) say(moved);
  };

  // == Board actions ==============================================================
  const addWidget = (type: string) => {
    const def = WIDGET_BY_TYPE.get(type);
    if (!def) return;
    const id = newWidgetId(items, type);
    const next = addItem(items, { id, type, w: def.size.w, h: def.size.h, settings: {} }, def.limits);
    commit(next, { refresh: true });
    if (!desktop) setTrayOpen(false);
    const placed = next.find((i) => i.id === id);
    if (placed) say(placed);
  };
  const remove = (id: string) => commit(removeItem(items, id));
  const shift = (id: string, by: -1 | 1) => commit(shiftInOrder(items, id, by, limitsOf));
  const applySettings = (id: string, settings: WidgetSettings, size: { w: number; h: number }) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    let next = items.map((i) => (i.id === id ? { ...i, settings } : i));
    if (size.w !== item.w || size.h !== item.h) next = compact(place(next, id, size, limitsOf(item.type)));
    commit(next, { refresh: true });
    setSettingsFor(null);
  };
  const reset = () => {
    commit(defaults, { refresh: true });
    setResetOpen(false);
  };

  const shown = preview ?? items;
  const order = useMemo(() => readingOrder(shown), [shown]);
  const bottom = shown.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  const settingsItem = settingsFor ? items.find((i) => i.id === settingsFor) ?? null : null;
  const finish = () => { setEditing(false); setTrayOpen(false); };

  return (
    <div className={cn("flex flex-col gap-4 transition-[padding] duration-200", editing && "select-none [-webkit-touch-callout:none]", trayOpen && desktop && "lg:pr-[400px]")}>
      <span role="status" className="sr-only">
        {status === "saving" ? t("dash.saving", locale) : status === "saved" ? t("dash.saved", locale) : ""}
      </span>
      {canEdit && editing ? (
        <div className="sticky top-16 z-20 -mx-1 flex flex-wrap items-center justify-end gap-2 rounded-2xl border border-sand-200 bg-surface/95 px-3 py-2 shadow-soft backdrop-blur lg:top-20">
          <span aria-hidden="true" className="mr-auto hidden text-sm text-sand-600 sm:inline">
            {status === "saving" ? t("dash.saving", locale) : status === "saved" ? t("dash.saved", locale) : t("dash.editing", locale)}
          </span>
          <Button variant={trayOpen ? "primary" : "secondary"} onClick={() => setTrayOpen((o) => !o)} aria-expanded={trayOpen} aria-controls="dash-tray">
            <PlusIcon className="text-lg" />
            {t("dash.addWidget", locale)}
          </Button>
          {/* One row on a phone, where a two-row sticky bar covered the board. */}
          <Button variant="ghost" onClick={() => setResetOpen(true)} aria-label={t("dash.reset", locale)}>
            <span className="sm:hidden">{t("dash.resetShort", locale)}</span>
            <span className="hidden sm:inline">{t("dash.reset", locale)}</span>
          </Button>
          <Button variant="primary" onClick={finish}>{t("dash.done", locale)}</Button>
        </div>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="rounded-xl border border-callout-danger-edge bg-callout-danger-bg px-4 py-3 text-sm text-callout-danger-ink">
          {t("dash.saveFailed", locale)}
        </p>
      ) : null}
      {editing ? <p className="text-sm text-sand-600">{t(desktop ? "dash.editHint" : "dash.editHintPhone", locale)}</p> : null}
      <p aria-live="polite" className="sr-only">{announce}</p>

      <div>
        {order.length === 0 && !drag ? (
          <p className="rounded-2xl border border-dashed border-sand-300 px-6 py-12 text-center text-sand-600">{t("dash.emptyBoard", locale)}</p>
        ) : (
          <div ref={gridRef} className="relative grid grid-cols-2 gap-4 [grid-auto-rows:72px] lg:grid-cols-12">
            {/* The cells a widget can land on, shown while arranging (laptop). */}
            {editing && desktop
              ? Array.from({ length: (Math.max(bottom, 6) + 3) * GRID_COLS }, (_, i) => (
                  <span
                    key={`cell-${i}`}
                    aria-hidden="true"
                    className="pointer-events-none rounded-xl bg-sand-200/35"
                    style={{ gridColumn: `${(i % GRID_COLS) + 1} / span 1`, gridRow: `${Math.floor(i / GRID_COLS) + 1} / span 1` }}
                  />
                ))
              : null}
            {order.map((item, index) => {
              const def = WIDGET_BY_TYPE.get(item.type);
              const frame = frames[item.id];
              const look = def ? CATEGORY_LOOK[def.category] : CATEGORY_LOOK.fleet;
              const name = title(item);
              const small = def?.shape === "kpi";
              const style = {
                "--x": item.x + 1, "--y": item.y + 1, "--w": item.w, "--h": item.h,
                "--hm": small ? 2 : Math.min(item.h, def?.shape === "attention" ? 8 : 5),
              } as CSSProperties;
              const placement = cn(
                small ? "col-span-1" : "col-span-2",
                "[grid-row:span_var(--hm)] lg:[grid-column:var(--x)/span_var(--w)] lg:[grid-row:var(--y)/span_var(--h)]",
              );
              // Where a lifted widget will land: the others have already made room around it.
              // The SAME <section> stays in the page, restyled: a touch keeps sending its moves
              // to the element it began on, and a replaced element would be detached, so the
              // moves would stop reaching the board (found driving a phone, 5 November).
              const holder = drag?.id === item.id || item.id === NEW_ID;
              return (
                <section
                  key={item.id}
                  data-widget-id={item.id}
                  data-widget-type={item.type}
                  data-drag-source={editing ? "board" : undefined}
                  onPointerDown={onPointerDown}
                  style={style}
                  aria-label={name}
                  aria-hidden={holder || undefined}
                  className={cn(
                    placement,
                    "relative flex min-h-0 min-w-0 flex-col rounded-2xl p-4 transition-shadow duration-150",
                    holder
                      ? "z-[1] border-2 border-dashed border-brand-600 bg-brand-tint/60 [&>*]:invisible"
                      : "z-[2] border border-sand-200 bg-surface shadow-card",
                    editing && !holder && "cursor-grab touch-pan-y ring-1 ring-sand-300 hover:shadow-soft hover:ring-brand-600/50 active:cursor-grabbing",
                    resizing?.id === item.id && "ring-2 ring-brand-600",
                  )}
                >
                  <FrameHeader
                    look={look}
                    name={name}
                    href={!editing && frame?.href && !frame.locked ? frame.href : undefined}
                    seeAll={t("dash.seeAll", locale)}
                    handle={editing ? (
                      <button
                        type="button"
                        data-no-drag
                        className="focus-ring sr-only flex size-8 shrink-0 items-center justify-center rounded-lg text-lg text-sand-600 focus:not-sr-only"
                        aria-label={t("dash.dragHandle", locale).replace("{title}", name)}
                        aria-describedby="dash-edit-hint"
                        onKeyDown={(e) => onHandleKey(e, item)}
                      >
                        <GripIcon />
                      </button>
                    ) : null}
                    controls={editing ? (
                      <span className="absolute -right-2 -top-2.5 z-10 flex items-center gap-1">
                        {!desktop ? (
                          <>
                            <IconButton round label={t("dash.moveEarlier", locale).replace("{title}", name)} disabled={index === 0} onClick={() => shift(item.id, -1)}>
                              <ChevronUpIcon />
                            </IconButton>
                            <IconButton round label={t("dash.moveLater", locale).replace("{title}", name)} disabled={index === order.length - 1} onClick={() => shift(item.id, 1)}>
                              <ChevronDownIcon />
                            </IconButton>
                          </>
                        ) : null}
                        <IconButton round label={t("dash.settingsFor", locale).replace("{title}", name)} onClick={() => setSettingsFor(item.id)}>
                          <SettingsIcon />
                        </IconButton>
                        <IconButton round label={t("dash.remove", locale).replace("{title}", name)} onClick={() => remove(item.id)}>
                          <CloseIcon />
                        </IconButton>
                      </span>
                    ) : null}
                  />
                  <div className={cn("min-h-0 flex-1", editing && "pointer-events-none")}>
                    {frame?.locked ? (
                      <p className="flex h-full items-center gap-2 text-sm text-sand-600">
                        <LockIcon className="shrink-0 text-base" />
                        {frame.locked}
                      </p>
                    ) : contents[item.id] ?? (
                      <div className="h-full animate-pulse rounded-xl bg-surface-sunken" aria-label={t("dash.loading", locale)} />
                    )}
                  </div>
                  {editing && desktop ? (
                    <>
                      <span data-no-drag aria-hidden="true" onPointerDown={(e) => startResize(e, item, "r")}
                        className="absolute inset-y-6 -right-1.5 w-3 cursor-ew-resize rounded-full hover:bg-brand-600/30" />
                      <span data-no-drag aria-hidden="true" onPointerDown={(e) => startResize(e, item, "b")}
                        className="absolute inset-x-6 -bottom-1.5 h-3 cursor-ns-resize rounded-full hover:bg-brand-600/30" />
                      <button
                        type="button"
                        data-no-drag
                        className="focus-ring absolute -bottom-1 -right-1 flex size-7 cursor-nwse-resize items-center justify-center rounded-full border border-sand-300 bg-surface text-sand-600 shadow-soft hover:text-brand-ink"
                        aria-label={t("dash.resizeHandle", locale).replace("{title}", name)}
                        onPointerDown={(e) => startResize(e, item, "rb")}
                        onKeyDown={(e) => onHandleKey(e, item, true)}
                      >
                        <ResizeIcon />
                      </button>
                    </>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </div>
      <span id="dash-edit-hint" className="sr-only">{t("dash.editHint", locale)}</span>

      {/* The widget being carried, under the pointer. */}
      {drag ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed left-0 top-0 z-50"
          style={{ transform: `translate(${drag.x - drag.grabX}px, ${drag.y - drag.grabY}px)`, width: drag.wPx, height: drag.hPx }}
        >
          <div className="flex h-full scale-[1.03] flex-col rounded-2xl border border-brand-600 bg-surface p-4 opacity-95 shadow-2xl ring-4 ring-brand-600/15">
            <FrameHeader
              look={CATEGORY_LOOK[WIDGET_BY_TYPE.get(drag.type)?.category ?? "fleet"]}
              name={drag.source === "board"
                ? title({ id: drag.id, type: drag.type, settings: items.find((i) => i.id === drag.id)?.settings })
                : t(`dash.w.${drag.type}.title`, locale)}
              seeAll=""
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              {drag.source === "board" ? contents[drag.id] : <Preview type={drag.type} locale={locale} />}
            </div>
          </div>
        </div>
      ) : null}

      {editing ? (
        <Tray
          open={trayOpen}
          onClose={() => setTrayOpen(false)}
          catalog={catalog}
          items={items}
          onAdd={addWidget}
          onPointerDown={onPointerDown}
          desktop={desktop}
          locale={locale}
        />
      ) : null}

      <Modal open={!!settingsItem} onClose={() => setSettingsFor(null)} title={settingsItem ? t("dash.settingsFor", locale).replace("{title}", title(settingsItem)) : ""} closeLabel={t("ui.close", locale)}>
        {settingsItem ? (
          <WidgetSettingsForm key={settingsItem.id} item={settingsItem} locale={locale} onCancel={() => setSettingsFor(null)} onSave={(s, size) => applySettings(settingsItem.id, s, size)} />
        ) : null}
      </Modal>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title={t("dash.reset", locale)}
        closeLabel={t("ui.close", locale)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>{t("common.cancel", locale)}</Button>
            <Button variant="primary" onClick={reset}>{t("dash.reset", locale)}</Button>
          </>
        }
      >
        <p className="text-sand-700">{t("dash.resetConfirm", locale)}</p>
      </Modal>
    </div>
  );
}

/** A widget's header: its group's icon on a tint, the title (a link to its page), controls. */
function FrameHeader({
  look, name, href, seeAll, handle, controls,
}: { look: { icon: ReactNode; tone: BadgeTone }; name: string; href?: string; seeAll: string; handle?: ReactNode; controls?: ReactNode }) {
  return (
    <header className="mb-3 flex min-h-8 items-center gap-2.5">
      {handle}
      <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl text-base", TONES[look.tone])}>
        {look.icon}
      </span>
      <h2 className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold text-sand-800">
        {href ? (
          <Link href={href} title={seeAll} className="focus-ring group -mx-1 inline-flex max-w-full items-center gap-0.5 rounded-md px-1 hover:text-brand-ink">
            <span className="line-clamp-2">{name}</span>
            <ChevronRightIcon className="shrink-0 text-base text-sand-500 transition group-hover:translate-x-0.5 group-hover:text-brand-ink" />
          </Link>
        ) : name}
      </h2>
      {controls}
    </header>
  );
}

function IconButton({ label, onClick, disabled, children, round = false }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode; round?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      data-no-drag
      onClick={onClick}
      className={cn(
        "focus-ring flex items-center justify-center text-lg text-sand-600 hover:text-sand-900 disabled:opacity-40",
        round
          ? "size-9 rounded-full border border-sand-200 bg-surface shadow-soft hover:bg-surface-hover lg:size-8"
          : "size-10 rounded-lg hover:bg-surface-hover lg:size-8",
      )}
    >
      {children}
    </button>
  );
}

/** A widget drawn with example figures, for the tray and while it is carried. */
function Preview({ type, locale }: { type: string; locale: Lang }) {
  const data = useMemo(() => sampleData(type, locale), [type, locale]);
  return data ? <WidgetBody type={type} settings={{}} data={data} locale={locale} /> : null;
}

/**
 * The widget tray: every widget with a live preview, by group, searchable. On a laptop a
 * panel beside the board (the board stays in view so a widget can be dragged onto it); on
 * a phone a sheet from the bottom, where pressing and holding a widget closes the sheet
 * and puts the widget in the person's hand, as a phone's home screen does.
 */
function Tray({
  open, onClose, catalog, items, onAdd, onPointerDown, desktop, locale,
}: {
  open: boolean; onClose: () => void; catalog: CatalogEntry[]; items: LayoutItem[]; onAdd: (type: string) => void;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void; desktop: boolean; locale: Lang;
}) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<WidgetCategory | "all">("all");
  const onBoard = new Set(items.map((i) => i.type));
  const q = query.trim().toLocaleLowerCase();
  const entries = catalog.filter((c) =>
    (cat === "all" || c.category === cat) &&
    (!q || `${t(`dash.w.${c.type}.title`, locale)} ${t(`dash.w.${c.type}.desc`, locale)}`.toLocaleLowerCase().includes(q)));
  const cats = CATEGORIES.filter((c) => catalog.some((e) => e.category === c));
  const tab = open ? 0 : -1;
  return (
    <aside
      id="dash-tray"
      aria-label={t("dash.tray.title", locale)}
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "fixed z-40 flex flex-col border-sand-200 bg-surface shadow-2xl transition-transform duration-200",
        desktop ? "inset-y-0 right-0 w-[400px] border-l" : "inset-x-0 bottom-0 h-[78dvh] rounded-t-3xl border-t",
        open ? "translate-x-0 translate-y-0" : desktop ? "translate-x-full" : "translate-y-full",
      )}
    >
      {!desktop ? <span aria-hidden="true" className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-sand-300" /> : null}
      <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
        <h2 className="text-lg font-semibold text-sand-900">{t("dash.tray.title", locale)}</h2>
        <IconButton label={t("ui.close", locale)} onClick={onClose}><CloseIcon /></IconButton>
      </div>
      <p className="px-5 text-sm text-sand-600">{t(desktop ? "dash.tray.hint" : "dash.tray.hintTouch", locale)}</p>
      <label className="relative mx-5 mt-3 block">
        <span className="sr-only">{t("dash.tray.search", locale)}</span>
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-sand-500" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("dash.tray.search", locale)}
          tabIndex={tab}
          className="focus-ring min-h-[44px] w-full rounded-xl border border-sand-300 bg-surface pl-9 pr-3 text-base text-sand-900 placeholder:text-sand-400"
        />
      </label>
      <div className="mt-3 flex gap-1.5 overflow-x-auto px-5 pb-2" role="group" aria-label={t("dash.tray.groups", locale)}>
        {(["all", ...cats] as const).map((c) => (
          <button
            key={c}
            type="button"
            tabIndex={tab}
            aria-pressed={cat === c}
            onClick={() => setCat(c)}
            className={cn(
              "focus-ring inline-flex min-h-9 shrink-0 items-center rounded-full border px-3 text-sm font-medium transition",
              cat === c ? "border-brand-600 bg-brand-600 text-white" : "border-sand-200 bg-surface text-sand-700 hover:bg-surface-hover",
            )}
          >
            {c === "all" ? t("dash.cat.all", locale) : t(`dash.cat.${c}`, locale)}
          </button>
        ))}
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-6 pt-1">
        {entries.length === 0 ? <li className="py-8 text-center text-sm text-sand-600">{t("dash.tray.none", locale)}</li> : null}
        {entries.map((c) => {
          const def = WIDGET_BY_TYPE.get(c.type)!;
          const look = CATEGORY_LOOK[c.category];
          return (
            <li
              key={c.type}
              data-drag-source={c.blocked ? undefined : "tray"}
              data-widget-type={c.type}
              onPointerDown={c.blocked ? undefined : onPointerDown}
              className={cn(
                "rounded-2xl border border-sand-200 bg-surface p-3 shadow-card",
                c.blocked ? "opacity-60" : "cursor-grab touch-pan-y hover:border-brand-600/60 active:cursor-grabbing",
              )}
            >
              <div className="flex items-start gap-2.5">
                <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl text-base", TONES[look.tone])}>{look.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sand-900">{t(`dash.w.${c.type}.title`, locale)}</p>
                  <p className="mt-0.5 line-clamp-2 text-sm text-sand-600">{t(`dash.w.${c.type}.desc`, locale)}</p>
                </div>
                <span className="shrink-0 rounded-md bg-surface-sunken px-1.5 py-0.5 text-xs font-medium tabular-nums text-sand-600">
                  {def.size.w} × {def.size.h}
                </span>
              </div>
              <div className={cn("pointer-events-none mt-3 overflow-hidden rounded-xl border border-sand-100 bg-surface-raised/60 p-3", def.shape === "kpi" ? "h-28" : "h-44")}>
                <Preview type={c.type} locale={locale} />
              </div>
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-sand-600">
                  {c.blocked ? <><LockIcon className="shrink-0" /><span>{c.blocked}</span></> : onBoard.has(c.type) ? t("dash.onBoard", locale) : t("dash.tray.example", locale)}
                </span>
                <Button size="sm" variant="secondary" disabled={!!c.blocked} tabIndex={tab} onClick={() => onAdd(c.type)} data-no-drag>
                  <PlusIcon className="text-base" />
                  {t("dash.add", locale)}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function WidgetSettingsForm({
  item, locale, onSave, onCancel,
}: { item: LayoutItem; locale: Lang; onSave: (s: WidgetSettings, size: { w: number; h: number }) => void; onCancel: () => void }) {
  const def = WIDGET_BY_TYPE.get(item.type);
  const [values, setValues] = useState<WidgetSettings>(() => {
    const v: WidgetSettings = {};
    for (const [k, o] of Object.entries(def?.options ?? {})) v[k] = item.settings[k] ?? o.default;
    v.title = item.settings.title ?? "";
    return v;
  });
  const [size, setSize] = useState({ w: item.w, h: item.h });
  if (!def) return null;
  // Applied to the board here, saved with it by the grid: nothing posts, so Save is a plain
  // button and Enter in the name field applies too.
  const apply = () => {
    const out: WidgetSettings = {};
    for (const [k, o] of Object.entries(def.options)) if (values[k] && values[k] !== o.default) out[k] = values[k];
    const name = (values.title ?? "").trim().slice(0, TITLE_MAX);
    if (name) out.title = name;
    onSave(out, size);
  };
  const chip = (on: boolean) => cn(
    "flex min-h-10 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600",
    on ? "border-brand-600 bg-brand-600 text-white" : "border-sand-300 bg-surface text-sand-800 hover:bg-surface-hover",
  );
  return (
    <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); apply(); }}>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-sand-800">{t("dash.optLabel.title", locale)}</span>
        <input
          type="text"
          maxLength={TITLE_MAX}
          value={values.title ?? ""}
          placeholder={t(`dash.w.${item.type}.title`, locale)}
          onChange={(e) => setValues({ ...values, title: e.target.value })}
          className="focus-ring min-h-[48px] rounded-lg border border-sand-300 bg-surface px-3 text-base text-sand-900 placeholder:text-sand-400 sm:min-h-[40px]"
        />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium text-sand-800">{t("dash.optLabel.size", locale)}</legend>
        <div className="flex flex-wrap gap-1.5">
          {SIZE_PRESETS[def.shape].map((p) => {
            const on = size.w === p.w && size.h === p.h;
            return (
              <label key={p.key} className={chip(on)}>
                <input type="radio" name="size" checked={on} onChange={() => setSize({ w: p.w, h: p.h })} className="sr-only" />
                <SizeGlyph w={p.w} h={p.h} />
                {t(`dash.size.${p.key}`, locale)}
              </label>
            );
          })}
        </div>
      </fieldset>
      {Object.entries(def.options).map(([key, opt]) => (
        <fieldset key={key} className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-sand-800">{t(`dash.optLabel.${key}`, locale)}</legend>
          <div className="flex flex-wrap gap-1.5">
            {opt.choices.map((c) => {
              const on = values[key] === c;
              return (
                <label key={c} className={chip(on)}>
                  <input type="radio" name={key} value={c} checked={on} onChange={() => setValues({ ...values, [key]: c })} className="sr-only" />
                  {key === "colour" && c !== "auto" ? <ColourDot hue={c} /> : null}
                  {t(`dash.opt.${key}.${c}`, locale)}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="flex justify-end gap-2 border-t border-sand-100 pt-4">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("common.cancel", locale)}</Button>
        <Button type="button" variant="primary" onClick={apply}>{t("common.save", locale)}</Button>
      </div>
    </form>
  );
}

/** A tiny picture of a size: its share of the 12-column row and of a tall widget. */
function SizeGlyph({ w, h }: { w: number; h: number }) {
  return (
    <span aria-hidden="true" className="relative h-4 w-6 shrink-0 rounded-[3px] border border-current opacity-80">
      <span className="absolute left-0 top-0 rounded-[2px] bg-current" style={{ width: `${(w / GRID_COLS) * 100}%`, height: `${Math.min(h / 6, 1) * 100}%` }} />
    </span>
  );
}

function ColourDot({ hue }: { hue: string }) {
  const s = HUES[hue as HueKey];
  return s ? <span aria-hidden="true" className="viz-c viz-bg size-3 shrink-0 rounded-full" style={swatchStyle(s) as CSSProperties} /> : null;
}
