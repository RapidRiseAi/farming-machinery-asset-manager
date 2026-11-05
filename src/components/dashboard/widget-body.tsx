import type { ReactNode } from "react";
import { t, type Lang } from "@/lib/i18n";
import type { WidgetData } from "@/lib/dashboard/compute";
import type { WidgetSettings } from "@/lib/dashboard/layout";
import { WIDGET_BY_TYPE, segmentColours, setting, type WidgetCategory } from "@/lib/dashboard/widgets";
import type { BadgeTone } from "@/components/ui/badge";
import type { HueKey } from "@/lib/dashboard/palettes";
import {
  CalendarIcon, CashIcon, DocumentsIcon, FaultsIcon, FuelIcon, MachinesIcon, WarningIcon,
} from "@/components/ui/icons";
import { BreakdownChart, KpiTile, ListWidget, SeriesChart } from "./charts";

/**
 * A widget's body from what it computed and the chart settings chosen for it. One
 * function for the board (server-rendered, the farm's figures) and the widget tray
 * (in the browser, example figures), so a preview is exactly what will be placed.
 */
export function WidgetBody({ type, settings, data, locale }: { type: string; settings: WidgetSettings; data: WidgetData; locale: Lang }) {
  const def = WIDGET_BY_TYPE.get(type);
  if (!def) return null;
  const opt = (k: string) => setting(def, settings, k);
  const title = settings.title || t(`dash.w.${type}.title`, locale);
  switch (data.kind) {
    case "kpi": return <KpiTile data={data} colour={opt("colour") || "auto"} large={opt("figure") === "large"} showTrend={opt("trend") !== "off"} locale={locale} />;
    case "series": return <SeriesChart data={data} chart={opt("chart")} colour={opt("colour")} labels={opt("labels") !== "off"} title={title} locale={locale} />;
    case "breakdown": return <BreakdownChart data={data} chart={opt("chart")} colours={opt("colours")} sort={opt("sort") === "name" ? "name" : "value"} overrides={segmentColours(def, settings)} title={title} locale={locale} />;
    case "list": return <ListWidget data={data} locale={locale} />;
  }
}

/**
 * Each group's icon and tint, on the widget's header and in the tray, and the colour a
 * tinted or outlined card wears when its card colour is left on "Group colour".
 */
export const CATEGORY_LOOK: Record<WidgetCategory, { icon: ReactNode; tone: BadgeTone; hue: HueKey }> = {
  attention: { icon: <WarningIcon />, tone: "danger", hue: "rose" },
  problems: { icon: <FaultsIcon />, tone: "danger", hue: "red" },
  servicing: { icon: <CalendarIcon />, tone: "warning", hue: "gold" },
  fleet: { icon: <MachinesIcon />, tone: "brand", hue: "green" },
  costs: { icon: <CashIcon />, tone: "ok", hue: "teal" },
  fuel: { icon: <FuelIcon />, tone: "info", hue: "orange" },
  papers: { icon: <DocumentsIcon />, tone: "neutral", hue: "slate" },
};
