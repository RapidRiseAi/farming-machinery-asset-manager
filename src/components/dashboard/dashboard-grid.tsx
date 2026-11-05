"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type CSSProperties, type ReactNode } from "react";

import { t, type Lang } from "@/lib/i18n";
import {
  GRID_COLS, addItem, compact, newWidgetId, place, readingOrder, removeItem, shiftInOrder,
  type GridBox, type LayoutItem, type SizeLimits, type WidgetSettings,
} from "@/lib/dashboard/layout";
import { CATEGORIES, TITLE_MAX, WIDGET_BY_TYPE, type WidgetCategory } from "@/lib/dashboard/widgets";
import { HUES, swatchStyle, type HueKey } from "@/lib/dashboard/palettes";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Modal } from "@/components/ui/dialog";
import {
  ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, CloseIcon, GripIcon, LockIcon, PlusIcon, ResizeIcon, SettingsIcon,
} from "@/components/ui/icons";

/** One grid row on a laptop, and the gap between widgets (gap-4). */
const ROW_PX = 72;
const GAP_PX = 16;

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

type Drag = { id: string; mode: "move" | "resize"; startX: number; startY: number; origin: GridBox; base: LayoutItem[] };

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

/**
 * The customisable board. The page renders each widget's body on the server and hands
 * them in as `contents`; this component owns only the arrangement: where each widget
 * sits, how big it is, which are on the board and their settings. Every change is saved
 * as a whole board (`save`), cleaned again on the server; adding a widget or changing its
 * settings also refreshes the page, which renders the new bodies.
 *
 * On a laptop (1024px and up) widgets sit on a 12-column grid at the positions saved. On
 * a phone the same board reads top to bottom in that order, small numbers two to a row.
 * Moving by dragging is a laptop gesture; the phone gets earlier and later buttons, and a
 * keyboard gets arrows on the drag handle (Shift and arrows to resize).
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
  const [preview, setPreview] = useState<LayoutItem[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [announce, setAnnounce] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [, startRefresh] = useTransition();
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const saveSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    (item: LayoutItem) => item.settings.title || frames[item.id]?.title || t(`dash.w.${item.type}.title`, locale),
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

  // == Dragging (laptop) ==========================================================
  const step = () => {
    const el = gridRef.current;
    const width = el ? el.getBoundingClientRect().width : 1200;
    return { x: (width - GAP_PX * (GRID_COLS - 1)) / GRID_COLS + GAP_PX, y: ROW_PX + GAP_PX };
  };

  const onPointerDown = (e: React.PointerEvent, item: LayoutItem, mode: Drag["mode"]) => {
    if (!editing || !desktop || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: item.id, mode, startX: e.clientX, startY: e.pageY, origin: { x: item.x, y: item.y, w: item.w, h: item.h }, base: items };
    setDragId(item.id);
    setPreview(items);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // Keep the page scrolling when a widget is dragged past the bottom or top edge.
    if (e.clientY > window.innerHeight - 48) window.scrollBy(0, 14);
    else if (e.clientY < 72) window.scrollBy(0, -14);
    const s = step();
    const dx = Math.round((e.clientX - d.startX) / s.x);
    const dy = Math.round((e.pageY - d.startY) / s.y);
    const item = d.base.find((i) => i.id === d.id)!;
    const box = d.mode === "move" ? { x: d.origin.x + dx, y: d.origin.y + dy } : { w: d.origin.w + dx, h: d.origin.h + dy };
    setPreview(place(d.base, d.id, box, limitsOf(item.type)));
  };

  const endDrag = (cancel: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const next = preview;
    setPreview(null);
    setDragId(null);
    if (cancel || !next) return;
    const settled = compact(next);
    const moved = settled.find((i) => i.id === d.id)!;
    const before = d.base.find((i) => i.id === d.id)!;
    if (moved.x === before.x && moved.y === before.y && moved.w === before.w && moved.h === before.h) return;
    commit(settled, { debounce: true });
    say(moved);
  };

  const say = (i: LayoutItem) =>
    setAnnounce(t("dash.moved", locale).replace("{title}", title(i)).replace("{x}", String(i.x + 1)).replace("{y}", String(i.y + 1))
      .replace("{w}", String(i.w)).replace("{h}", String(i.h)));

  // == Keyboard on the handle =====================================================
  const onHandleKey = (e: React.KeyboardEvent, item: LayoutItem, resizeOnly = false) => {
    const k = e.key;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(k)) return;
    e.preventDefault();
    const dx = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0;
    const dy = k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0;
    const resize = resizeOnly || e.shiftKey;
    const box = resize ? { w: item.w + dx, h: item.h + dy } : { x: item.x + dx, y: item.y + dy };
    // Moving up past the widget above swaps with it; gravity would otherwise put it back.
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
    const next = addItem(items, { id: newWidgetId(items, type), type, w: def.size.w, h: def.size.h, settings: {} }, def.limits);
    commit(next, { refresh: true });
    setCatalogOpen(false);
  };
  const remove = (id: string) => commit(removeItem(items, id));
  const shift = (id: string, by: -1 | 1) => commit(shiftInOrder(items, id, by, limitsOf));
  const applySettings = (id: string, settings: WidgetSettings) => {
    commit(items.map((i) => (i.id === id ? { ...i, settings } : i)), { refresh: true });
    setSettingsFor(null);
  };
  const reset = () => {
    commit(defaults, { refresh: true });
    setResetOpen(false);
  };

  const shown = preview ?? items;
  const order = useMemo(() => readingOrder(shown), [shown]);
  const settingsItem = settingsFor ? items.find((i) => i.id === settingsFor) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <span role="status" className="sr-only">
        {status === "saving" ? t("dash.saving", locale) : status === "saved" ? t("dash.saved", locale) : ""}
      </span>
      {canEdit && editing ? (
        <div className="sticky top-16 z-20 -mx-1 flex flex-wrap items-center justify-end gap-2 rounded-xl border border-sand-200 bg-surface/95 px-3 py-2 shadow-soft backdrop-blur lg:top-20">
          <span aria-hidden="true" className="mr-auto text-sm text-sand-600">
            {status === "saving" ? t("dash.saving", locale) : status === "saved" ? t("dash.saved", locale) : t("dash.editing", locale)}
          </span>
          <Button variant="secondary" onClick={() => setCatalogOpen(true)}>
            <PlusIcon className="text-lg" />
            {t("dash.addWidget", locale)}
          </Button>
          <Button variant="ghost" onClick={() => setResetOpen(true)}>{t("dash.reset", locale)}</Button>
          <Button variant="primary" onClick={() => setEditing(false)}>{t("dash.done", locale)}</Button>
        </div>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="rounded-lg border border-callout-danger-edge bg-callout-danger-bg px-4 py-3 text-sm text-callout-danger-ink">
          {t("dash.saveFailed", locale)}
        </p>
      ) : null}
      {editing ? <p className="text-sm text-sand-600">{t(desktop ? "dash.editHint" : "dash.editHintPhone", locale)}</p> : null}
      <p aria-live="polite" className="sr-only">{announce}</p>

      {order.length === 0 ? (
        <p className="rounded-xl border border-dashed border-sand-300 px-6 py-12 text-center text-sand-600">{t("dash.emptyBoard", locale)}</p>
      ) : (
        <div
          ref={gridRef}
          onPointerMove={onPointerMove}
          onPointerUp={() => endDrag(false)}
          onPointerCancel={() => endDrag(true)}
          onKeyDown={(e) => { if (e.key === "Escape" && drag.current) endDrag(true); }}
          className={cn(
            "grid grid-cols-2 gap-4 [grid-auto-rows:72px] lg:grid-cols-12",
            editing && desktop && "rounded-xl outline-dashed outline-1 outline-offset-8 outline-sand-300",
          )}
        >
          {order.map((item, index) => {
            const def = WIDGET_BY_TYPE.get(item.type);
            const frame = frames[item.id];
            const small = def?.shape === "kpi";
            const style = {
              "--x": item.x + 1, "--y": item.y + 1, "--w": item.w, "--h": item.h,
              "--hm": small ? 2 : Math.min(item.h, def?.shape === "attention" ? 8 : 5),
            } as CSSProperties;
            const name = title(item);
            return (
              <section
                key={item.id}
                style={style}
                aria-label={name}
                className={cn(
                  "relative flex min-h-0 min-w-0 flex-col rounded-xl border border-sand-200 bg-surface p-4 shadow-card",
                  small ? "col-span-1" : "col-span-2",
                  "[grid-row:span_var(--hm)] lg:[grid-column:var(--x)/span_var(--w)] lg:[grid-row:var(--y)/span_var(--h)]",
                  editing && "ring-1 ring-sand-300",
                  dragId === item.id && "z-10 shadow-soft ring-2 ring-brand-600",
                )}
              >
                <header className="mb-2 flex min-h-7 items-center gap-1.5">
                  {editing && desktop ? (
                    <button
                      type="button"
                      className="focus-ring -ml-1.5 flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-lg text-sand-600 hover:bg-surface-hover active:cursor-grabbing"
                      aria-label={t("dash.dragHandle", locale).replace("{title}", name)}
                      aria-describedby="dash-edit-hint"
                      onPointerDown={(e) => onPointerDown(e, item, "move")}
                      onKeyDown={(e) => onHandleKey(e, item)}
                    >
                      <GripIcon />
                    </button>
                  ) : null}
                  <h2 className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold text-sand-800">
                    {!editing && frame?.href && !frame.locked ? (
                      <Link
                        href={frame.href}
                        title={t("dash.seeAll", locale)}
                        className="focus-ring group -mx-1 inline-flex max-w-full items-center gap-0.5 rounded-md px-1 hover:text-brand-ink"
                      >
                        <span className="line-clamp-2">{name}</span>
                        <ChevronRightIcon className="shrink-0 text-base text-sand-500 transition group-hover:translate-x-0.5 group-hover:text-brand-ink" />
                      </Link>
                    ) : name}
                  </h2>
                  {editing ? (
                    <span className="flex shrink-0 items-center">
                      {!desktop ? (
                        <>
                          <IconButton label={t("dash.moveEarlier", locale).replace("{title}", name)} disabled={index === 0} onClick={() => shift(item.id, -1)}>
                            <ChevronUpIcon />
                          </IconButton>
                          <IconButton label={t("dash.moveLater", locale).replace("{title}", name)} disabled={index === order.length - 1} onClick={() => shift(item.id, 1)}>
                            <ChevronDownIcon />
                          </IconButton>
                        </>
                      ) : null}
                      {def ? (
                        <IconButton label={t("dash.settingsFor", locale).replace("{title}", name)} onClick={() => setSettingsFor(item.id)}>
                          <SettingsIcon />
                        </IconButton>
                      ) : null}
                      <IconButton label={t("dash.remove", locale).replace("{title}", name)} onClick={() => remove(item.id)}>
                        <CloseIcon />
                      </IconButton>
                    </span>
                  ) : null}
                </header>
                <div className={cn("min-h-0 flex-1", editing && "pointer-events-none select-none")}>
                  {frame?.locked ? (
                    <p className="flex h-full items-center gap-2 text-sm text-sand-600">
                      <LockIcon className="shrink-0 text-base" />
                      {frame.locked}
                    </p>
                  ) : contents[item.id] ?? (
                    <div className="h-full animate-pulse rounded-lg bg-surface-sunken" aria-label={t("dash.loading", locale)} />
                  )}
                </div>
                {editing && desktop ? (
                  <button
                    type="button"
                    className="focus-ring absolute bottom-0.5 right-0.5 flex size-7 cursor-nwse-resize touch-none items-center justify-center rounded-md text-sand-500 hover:bg-surface-hover"
                    aria-label={t("dash.resizeHandle", locale).replace("{title}", name)}
                    onPointerDown={(e) => onPointerDown(e, item, "resize")}
                    onKeyDown={(e) => onHandleKey(e, item, true)}
                  >
                    <ResizeIcon />
                  </button>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
      <span id="dash-edit-hint" className="sr-only">{t("dash.editHint", locale)}</span>

      <Modal open={catalogOpen} onClose={() => setCatalogOpen(false)} title={t("dash.catalogTitle", locale)} closeLabel={t("ui.close", locale)} className="max-w-3xl">
        <Catalog catalog={catalog} items={items} onAdd={addWidget} locale={locale} />
      </Modal>

      <Modal open={!!settingsItem} onClose={() => setSettingsFor(null)} title={settingsItem ? t("dash.settingsFor", locale).replace("{title}", title(settingsItem)) : ""} closeLabel={t("ui.close", locale)}>
        {settingsItem ? (
          <WidgetSettingsForm key={settingsItem.id} item={settingsItem} locale={locale} onCancel={() => setSettingsFor(null)} onSave={(s) => applySettings(settingsItem.id, s)} />
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

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="focus-ring flex size-10 items-center justify-center rounded-md text-lg text-sand-600 hover:bg-surface-hover hover:text-sand-900 disabled:opacity-40 lg:size-8"
    >
      {children}
    </button>
  );
}

function Catalog({ catalog, items, onAdd, locale }: { catalog: CatalogEntry[]; items: LayoutItem[]; onAdd: (type: string) => void; locale: Lang }) {
  const onBoard = new Set(items.map((i) => i.type));
  return (
    <div className="flex max-h-[65vh] flex-col gap-5 overflow-y-auto pr-1">
      {CATEGORIES.map((cat) => {
        const entries = catalog.filter((c) => c.category === cat);
        if (entries.length === 0) return null;
        return (
          <section key={cat}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-sand-600">{t(`dash.cat.${cat}`, locale)}</h3>
            <ul className="grid gap-2 sm:grid-cols-2">
              {entries.map((c) => (
                <li key={c.type} className="flex flex-col gap-2 rounded-lg border border-sand-200 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sand-900">{t(`dash.w.${c.type}.title`, locale)}</p>
                    <p className="mt-0.5 text-sm text-sand-600">{t(`dash.w.${c.type}.desc`, locale)}</p>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-sand-600">{c.blocked ?? (onBoard.has(c.type) ? t("dash.onBoard", locale) : "")}</span>
                    <Button size="sm" variant="secondary" disabled={!!c.blocked} onClick={() => onAdd(c.type)}>
                      <PlusIcon className="text-base" />
                      {t("dash.add", locale)}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function WidgetSettingsForm({
  item, locale, onSave, onCancel,
}: { item: LayoutItem; locale: Lang; onSave: (s: WidgetSettings) => void; onCancel: () => void }) {
  const def = WIDGET_BY_TYPE.get(item.type);
  const [values, setValues] = useState<WidgetSettings>(() => {
    const v: WidgetSettings = {};
    for (const [k, o] of Object.entries(def?.options ?? {})) v[k] = item.settings[k] ?? o.default;
    v.title = item.settings.title ?? "";
    return v;
  });
  if (!def) return null;
  // Applied to the board here, saved with it by the grid: nothing posts, so the Save button
  // is a plain button and Enter in the name field applies too.
  const apply = () => {
    const out: WidgetSettings = {};
    for (const [k, o] of Object.entries(def.options)) if (values[k] && values[k] !== o.default) out[k] = values[k];
    const name = (values.title ?? "").trim().slice(0, TITLE_MAX);
    if (name) out.title = name;
    onSave(out);
  };
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
      {Object.entries(def.options).map(([key, opt]) => (
        <fieldset key={key} className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-sand-800">{t(`dash.optLabel.${key}`, locale)}</legend>
          <div className="flex flex-wrap gap-1.5">
            {opt.choices.map((c) => {
              const on = values[key] === c;
              return (
                <label
                  key={c}
                  className={cn(
                    "flex min-h-10 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600",
                    on ? "border-brand-600 bg-brand-600 text-white" : "border-sand-300 bg-surface text-sand-800 hover:bg-surface-hover",
                  )}
                >
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

function ColourDot({ hue }: { hue: string }) {
  const s = HUES[hue as HueKey];
  return s ? <span aria-hidden="true" className="viz-c viz-bg size-3 shrink-0 rounded-full" style={swatchStyle(s) as CSSProperties} /> : null;
}
