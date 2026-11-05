/**
 * Every widget the dashboard can show: what it is, how big it starts, what a person may
 * change about it, what it needs to be allowed, and WHERE THE SAME DATA LIVES.
 *
 * That last one is the rule of this dashboard: it is a window onto the other screens,
 * never the only place a number exists. Every widget names the page (with the filter)
 * that shows what it counted, and the frame links there. `widgets.test.ts` checks that
 * each of those pages exists.
 *
 * Pure data: imported by the server (to validate and compute) and by the grid in the
 * browser (to offer the catalogue and the settings).
 */
import type { Feature } from "@/lib/entitlements";
import type { FarmModule } from "@/lib/modules";
import type { SizeLimits, WidgetSettings } from "./layout";
import { HUE_KEYS, PALETTE_KEYS } from "./palettes";

export type WidgetShape = "kpi" | "series" | "breakdown" | "list" | "attention";
export type WidgetCategory = "attention" | "problems" | "servicing" | "fleet" | "costs" | "fuel" | "papers";

/** `custom`: a hex colour (a preset or the colour wheel) is accepted besides the choices. */
export type WidgetOption = { choices: readonly string[]; default: string; custom?: true };

/** A data range a person may colour on its own (a breakdown's slice), and its label key. */
export type Segment = { key: string; labelKey: string; status?: "ok" | "warn" | "bad" | "neutral" };

/** The data each widget reads; the page fetches only what the board on screen needs. */
export type SourceKey = "machines" | "service" | "faults" | "jobCards" | "fuel" | "licences" | "fines";

export type WidgetDef = {
  type: string;
  category: WidgetCategory;
  shape: WidgetShape;
  size: { w: number; h: number };
  limits: SizeLimits;
  options: Record<string, WidgetOption>;
  needs?: { costs?: true; feature?: Feature; module?: FarmModule };
  sources: SourceKey[];
  /** The screen that shows this data, with the filter that matches the widget. */
  href: (s: WidgetSettings) => string;
  /** The slices of a breakdown, each colourable in settings (`c.<key>`). */
  segments?: Segment[];
};

// == Shared option sets =========================================================
const KPI_COLOUR: WidgetOption = { choices: ["auto", ...HUE_KEYS], default: "auto", custom: true };
const LINE_COLOUR: WidgetOption = { choices: HUE_KEYS, default: "green", custom: true };
const SERIES_CHART: WidgetOption = { choices: ["bar", "line", "area"], default: "bar" };
const BREAKDOWN_CHART: WidgetOption = { choices: ["donut", "pie", "bars", "list"], default: "donut" };
const STATUS_COLOURS: WidgetOption = { choices: ["status", ...PALETTE_KEYS], default: "status" };
const CATEGORY_COLOURS: WidgetOption = { choices: PALETTE_KEYS, default: "fleetwise" };
const MONTHS: WidgetOption = { choices: ["3", "6", "12"], default: "6" };
const DAYS: WidgetOption = { choices: ["1", "7", "30"], default: "7" };
const ROWS: WidgetOption = { choices: ["5", "10"], default: "5" };
const COMPARE: WidgetOption = { choices: ["on", "off"], default: "on" };

const KPI = { shape: "kpi" as const, size: { w: 3, h: 2 }, limits: { minW: 2, minH: 2, maxW: 6, maxH: 3 } };
const SERIES = { shape: "series" as const, size: { w: 6, h: 4 }, limits: { minW: 3, minH: 3, maxW: 12, maxH: 8 } };
const BREAKDOWN = { shape: "breakdown" as const, size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 12, maxH: 8 } };
const LIST = { shape: "list" as const, size: { w: 6, h: 4 }, limits: { minW: 3, minH: 3, maxW: 12, maxH: 10 } };

/** Days to months, for a "since" filter that covers a chart's whole period. */
const monthsAsDays = (m: string) => String(Number(m) * 31);

export const WIDGETS: WidgetDef[] = [
  // == Needs your attention ======================================================
  {
    type: "attention", category: "attention", shape: "attention",
    size: { w: 8, h: 6 }, limits: { minW: 4, minH: 3, maxW: 12, maxH: 12 },
    options: {}, sources: ["machines", "service", "faults", "licences", "fines"],
    href: () => "/faults",
  },

  // == Problems ==================================================================
  { type: "open_problems", category: "problems", ...KPI, options: { colour: KPI_COLOUR },
    sources: ["machines", "faults"], href: () => "/faults" },
  { type: "new_problems", category: "problems", ...KPI, options: { days: DAYS, colour: KPI_COLOUR },
    sources: ["machines", "faults"], href: (s) => `/faults?since=${s.days ?? DAYS.default}` },
  { type: "machines_with_problems", category: "problems", ...KPI, options: { colour: KPI_COLOUR },
    sources: ["machines", "faults"], href: () => "/machines?problems=open" },
  { type: "machines_stopped", category: "problems", ...KPI, options: { colour: KPI_COLOUR },
    sources: ["machines", "faults"], href: () => "/faults?urgency=stopped" },
  { type: "problems_trend", category: "problems", ...SERIES, options: { months: MONTHS, chart: SERIES_CHART, colour: LINE_COLOUR },
    sources: ["machines", "faults"], href: (s) => `/faults?since=${monthsAsDays(s.months ?? MONTHS.default)}` },
  { type: "problems_by_urgency", category: "problems", ...BREAKDOWN, options: { chart: BREAKDOWN_CHART, colours: STATUS_COLOURS },
    sources: ["machines", "faults"], href: () => "/faults" },
  { type: "latest_problems", category: "problems", ...LIST, options: { rows: ROWS },
    sources: ["machines", "faults"], href: () => "/faults" },

  // == Servicing =================================================================
  { type: "service_overdue", category: "servicing", ...KPI, options: { colour: KPI_COLOUR },
    sources: ["machines", "service"], href: () => "/machines?service=overdue" },
  { type: "service_due", category: "servicing", ...KPI, options: { colour: KPI_COLOUR },
    sources: ["machines", "service"], href: () => "/machines?service=due" },
  { type: "service_status", category: "servicing", ...BREAKDOWN, options: { chart: BREAKDOWN_CHART, colours: STATUS_COLOURS },
    sources: ["machines", "service"], href: () => "/machines?sort=attention" },
  { type: "upcoming_services", category: "servicing", ...LIST, options: { rows: ROWS },
    needs: { module: "calendar" }, sources: ["machines", "service"], href: () => "/calendar" },
  { type: "stale_meters", category: "servicing", ...LIST, options: { rows: ROWS },
    sources: ["machines"], href: () => "/machines?sort=lastread" },

  // == Fleet =====================================================================
  { type: "fleet_size", category: "fleet", ...KPI, options: { colour: KPI_COLOUR },
    sources: ["machines"], href: () => "/machines" },
  { type: "fleet_status", category: "fleet", ...BREAKDOWN, options: { chart: BREAKDOWN_CHART, colours: STATUS_COLOURS },
    sources: ["machines"], href: () => "/machines" },
  { type: "in_workshop", category: "fleet", ...LIST, options: { rows: ROWS },
    sources: ["machines", "jobCards"], href: () => "/machines?status=in_workshop" },
  { type: "open_job_cards", category: "fleet", ...KPI, options: { colour: KPI_COLOUR },
    sources: ["machines", "jobCards"], href: () => "/jobcards" },
  { type: "job_cards_by_status", category: "fleet", ...BREAKDOWN, options: { chart: BREAKDOWN_CHART, colours: CATEGORY_COLOURS },
    sources: ["machines", "jobCards"], href: () => "/jobcards" },

  // == Costs (Professional, and only for people who may see money) ===============
  { type: "spend_month", category: "costs", ...KPI, options: { compare: COMPARE, colour: KPI_COLOUR },
    needs: { costs: true, feature: "tco" }, sources: ["machines", "jobCards"], href: () => "/reports?tab=costs&period=thisMonth" },
  { type: "spend_trend", category: "costs", ...SERIES, options: { months: MONTHS, chart: SERIES_CHART, colour: LINE_COLOUR },
    needs: { costs: true, feature: "tco" }, sources: ["machines", "jobCards"], href: () => "/reports?tab=costs&period=thisYear" },
  { type: "spend_by_type", category: "costs", ...BREAKDOWN, options: { months: MONTHS, chart: BREAKDOWN_CHART, colours: CATEGORY_COLOURS },
    needs: { costs: true, feature: "tco" }, sources: ["machines", "jobCards"], href: () => "/reports?tab=costs&period=thisYear" },
  { type: "top_cost_machines", category: "costs", ...BREAKDOWN, size: { w: 6, h: 4 },
    options: { months: MONTHS, rows: ROWS, chart: { choices: ["bars", "donut", "pie", "list"], default: "bars" }, colours: CATEGORY_COLOURS },
    needs: { costs: true, feature: "tco" }, sources: ["machines", "jobCards"], href: () => "/reports?tab=costs&period=thisYear" },

  // == Fuel ======================================================================
  { type: "fuel_litres_month", category: "fuel", ...KPI, options: { compare: COMPARE, colour: KPI_COLOUR },
    needs: { feature: "fuel", module: "fuel" }, sources: ["machines", "fuel"], href: () => "/fuel" },
  { type: "fuel_spend_month", category: "fuel", ...KPI, options: { compare: COMPARE, colour: KPI_COLOUR },
    needs: { costs: true, feature: "fuel", module: "fuel" }, sources: ["machines", "fuel"], href: () => "/fuel" },
  { type: "fuel_trend", category: "fuel", ...SERIES, options: { months: MONTHS, chart: SERIES_CHART, colour: { choices: HUE_KEYS, default: "gold", custom: true } },
    needs: { feature: "fuel", module: "fuel" }, sources: ["machines", "fuel"], href: () => "/reports?tab=fuel&period=thisYear" },
  { type: "fuel_flags", category: "fuel", ...KPI, options: { colour: KPI_COLOUR },
    needs: { feature: "fuel", module: "fuel" }, sources: ["machines", "fuel"], href: () => "/fuel" },

  // == Papers and fines ==========================================================
  { type: "expiring_papers", category: "papers", ...LIST, options: { rows: ROWS },
    sources: ["machines", "licences"], href: () => "/calendar" },
  { type: "fines_to_nominate", category: "papers", ...KPI, options: { colour: KPI_COLOUR },
    needs: { feature: "aarto", module: "fines" }, sources: ["machines", "fines"], href: () => "/fines" },
];

/** Number widgets that carry a trend line (compute.ts fills `trend` for these). */
const HAS_TREND = new Set(["open_problems", "new_problems", "spend_month", "fuel_litres_month", "fuel_spend_month"]);

// Options every widget offers, and the extras of its shape, added once here so the list
// above stays about what each widget IS. Order is the order the settings show them.
for (const w of WIDGETS) {
  const extra: Record<string, WidgetOption> = {};
  if (w.shape === "kpi") {
    extra.figure = { choices: ["normal", "large"], default: "normal" };
    if (HAS_TREND.has(w.type)) extra.trend = { choices: ["on", "off"], default: "on" };
  }
  if (w.shape === "series") extra.labels = { choices: ["on", "off"], default: "on" };
  if (w.shape === "breakdown") extra.sort = { choices: ["value", "name"], default: "value" };
  w.options = {
    ...w.options,
    ...extra,
    accent: { choices: ["group", ...HUE_KEYS], default: "group", custom: true },
    style: { choices: ["plain", "tinted", "outline"], default: "plain" },
  };
}

// The slices each breakdown draws, so each can be given its own colour.
const SEG: Record<string, Segment[]> = {
  problems_by_urgency: [
    { key: "stopped", labelKey: "urgency.stopped", status: "bad" },
    { key: "limping", labelKey: "urgency.limping", status: "warn" },
    { key: "can_work", labelKey: "urgency.can_work", status: "ok" },
  ],
  service_status: [
    { key: "overdue", labelKey: "ui.statusOverdue", status: "bad" },
    { key: "due_soon", labelKey: "ui.statusDueSoon", status: "warn" },
    { key: "ok", labelKey: "ui.statusOk", status: "ok" },
    { key: "none", labelKey: "dash.noPlan", status: "neutral" },
  ],
  fleet_status: [
    { key: "active", labelKey: "machineStatus.active", status: "ok" },
    { key: "standby", labelKey: "machineStatus.standby", status: "neutral" },
    { key: "in_workshop", labelKey: "machineStatus.in_workshop", status: "warn" },
    { key: "out_of_service", labelKey: "machineStatus.out_of_service", status: "bad" },
  ],
  job_cards_by_status: ["reported", "open", "in_progress", "waiting_parts"].map((k) => ({ key: k, labelKey: `jobStatus.${k}` })),
  spend_by_type: [...["scheduled_service", "repair", "inspection"].map((k) => ({ key: k, labelKey: `jobType.${k}` })), { key: "other", labelKey: "dash.other" }],
  // Machines change; their colours go by rank, largest first.
  top_cost_machines: [...[1, 2, 3, 4, 5].map((n) => ({ key: `r${n}`, labelKey: `dash.rank.${n}` })), { key: "other", labelKey: "dash.other" }],
};
for (const w of WIDGETS) if (SEG[w.type]) w.segments = SEG[w.type];

export const WIDGET_BY_TYPE: ReadonlyMap<string, WidgetDef> = new Map(WIDGETS.map((w) => [w.type, w]));

/**
 * One-tap sizes, as on a phone's home screen. Each sits inside every widget of its shape's
 * limits (`widgets.test.ts`); the corner handle still gives any size in between.
 */
export const SIZE_PRESETS: Record<WidgetShape, { key: "s" | "m" | "l" | "wide"; w: number; h: number }[]> = {
  kpi: [{ key: "s", w: 2, h: 2 }, { key: "m", w: 3, h: 2 }, { key: "l", w: 4, h: 3 }, { key: "wide", w: 6, h: 2 }],
  series: [{ key: "s", w: 4, h: 3 }, { key: "m", w: 6, h: 4 }, { key: "l", w: 8, h: 5 }, { key: "wide", w: 12, h: 4 }],
  breakdown: [{ key: "s", w: 3, h: 3 }, { key: "m", w: 4, h: 4 }, { key: "l", w: 6, h: 5 }, { key: "wide", w: 12, h: 4 }],
  list: [{ key: "s", w: 4, h: 3 }, { key: "m", w: 6, h: 4 }, { key: "l", w: 6, h: 6 }, { key: "wide", w: 12, h: 4 }],
  attention: [{ key: "s", w: 6, h: 4 }, { key: "m", w: 8, h: 6 }, { key: "l", w: 12, h: 6 }, { key: "wide", w: 12, h: 4 }],
};
export const CATEGORIES: WidgetCategory[] = ["attention", "problems", "servicing", "fleet", "costs", "fuel", "papers"];

/** What this person on this farm may have: money, plan features, switched-on modules. */
export type WidgetAccess = {
  costs: boolean;
  features: Partial<Record<Feature, boolean>>;
  modules: Partial<Record<FarmModule, boolean>>;
};

/** Why a widget cannot show here, or null when it can. */
export function widgetBlock(def: WidgetDef, access: WidgetAccess): "costs" | "plan" | "module" | null {
  if (def.needs?.feature && access.features[def.needs.feature] === false) return "plan";
  if (def.needs?.costs && !access.costs) return "costs";
  if (def.needs?.module && access.modules[def.needs.module] === false) return "module";
  return null;
}

/** A setting's value, or the widget's default for it. */
export function setting(def: WidgetDef, s: WidgetSettings, key: string): string {
  const opt = def.options[key];
  const v = s[key];
  if (!opt || v === undefined) return opt?.default ?? "";
  return opt.choices.includes(v) || (opt.custom && /^#[0-9a-f]{6}$/i.test(v)) ? v : opt.default;
}

/** The colours picked for a breakdown's slices, by slice key. */
export function segmentColours(def: WidgetDef, s: WidgetSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const seg of def.segments ?? []) {
    const v = s[`c.${seg.key}`];
    if (v && /^#[0-9a-f]{6}$/i.test(v)) out[seg.key] = v;
  }
  return out;
}

/** Custom titles are short and plain. */
export const TITLE_MAX = 40;
