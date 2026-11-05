import type { ReactNode } from "react";
import { t, type Lang } from "@/lib/i18n";
import type { WidgetData } from "@/lib/dashboard/compute";
import type { WidgetSettings } from "@/lib/dashboard/layout";
import { WIDGET_BY_TYPE, setting, type WidgetCategory } from "@/lib/dashboard/widgets";
import type { BadgeTone } from "@/components/ui/badge";
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
    case "kpi": return <KpiTile data={data} colour={opt("colour") || "auto"} locale={locale} />;
    case "series": return <SeriesChart data={data} chart={opt("chart")} colour={opt("colour")} title={title} locale={locale} />;
    case "breakdown": return <BreakdownChart data={data} chart={opt("chart")} colours={opt("colours")} title={title} locale={locale} />;
    case "list": return <ListWidget data={data} locale={locale} />;
  }
}

/** Each group's icon and tint, on the widget's header and in the tray. */
export const CATEGORY_LOOK: Record<WidgetCategory, { icon: ReactNode; tone: BadgeTone }> = {
  attention: { icon: <WarningIcon />, tone: "danger" },
  problems: { icon: <FaultsIcon />, tone: "danger" },
  servicing: { icon: <CalendarIcon />, tone: "warning" },
  fleet: { icon: <MachinesIcon />, tone: "brand" },
  costs: { icon: <CashIcon />, tone: "ok" },
  fuel: { icon: <FuelIcon />, tone: "info" },
  papers: { icon: <DocumentsIcon />, tone: "neutral" },
};
