/**
 * Example figures for the widget tray's previews: each widget drawn with the real chart
 * components, so a person sees what they are adding before it is on the board. Made up,
 * the same for every farm, and labelled as an example on the tray; the board itself only
 * ever shows the farm's own numbers.
 */
import { t, type Lang } from "@/lib/i18n";
import type { WidgetData } from "./compute";

const months = (locale: Lang) => {
  const tag = locale === "af" ? "af-ZA" : "en-ZA";
  return Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(2026, 5 + i, 15)).toLocaleDateString(tag, { month: "short", timeZone: "UTC" }));
};
const series = (locale: Lang, values: number[], format: "count" | "rands" | "litres"): WidgetData => ({
  kind: "series", format, points: months(locale).map((label, i) => ({ key: String(i), label, value: values[i] })),
});
const row = (key: string, title: string, sub: string, badge?: { label: string; tone: "danger" | "warning" | "ok" | "neutral" }) =>
  ({ key, title, sub, href: "#", badge });

export function sampleData(type: string, locale: Lang): WidgetData | null {
  const L = (k: string) => t(k, locale);
  switch (type) {
    case "open_problems": return { kind: "kpi", value: 5, format: "count", tone: "bad", sub: L("dash.sub.stoppedMany").replace("{n}", "2"), trend: [3, 6, 4, 7, 5, 5] };
    case "new_problems": return { kind: "kpi", value: 3, format: "count", tone: "warn", sub: L("dash.sub.days7"), trend: [1, 4, 2, 2, 5, 3, 1, 3] };
    case "machines_with_problems": return { kind: "kpi", value: 4, format: "count", tone: "warn", sub: L("dash.sub.ofMachines").replace("{n}", "12") };
    case "machines_stopped": return { kind: "kpi", value: 2, format: "count", tone: "bad", sub: L("dash.sub.standingStill") };
    case "service_overdue": return { kind: "kpi", value: 2, format: "count", tone: "bad", sub: L("dash.sub.taskMany").replace("{n}", "3") };
    case "service_due": return { kind: "kpi", value: 5, format: "count", tone: "warn", sub: L("dash.sub.taskMany").replace("{n}", "7") };
    case "fleet_size": return { kind: "kpi", value: 12, format: "count", tone: "neutral", sub: L("dash.sub.working").replace("{n}", "9") };
    case "open_job_cards": return { kind: "kpi", value: 4, format: "count", tone: "neutral", sub: L("dash.sub.waitingParts").replace("{n}", "1") };
    case "spend_month": return { kind: "kpi", value: 1_845_000, format: "rands", tone: "neutral", sub: L("dashboard.thisMonth"), delta: { amount: 230_000, more: false, month: months(locale)[4], tone: "ok" }, trend: [2_400_000, 1_200_000, 3_100_000, 1_900_000, 2_075_000, 1_845_000] };
    case "fuel_litres_month": return { kind: "kpi", value: 3_420, format: "litres", tone: "neutral", sub: L("dashboard.thisMonth"), trend: [2_900, 4_100, 5_200, 3_800, 3_100, 3_420] };
    case "fuel_spend_month": return { kind: "kpi", value: 8_550_000, format: "rands", tone: "neutral", sub: L("dashboard.thisMonth"), trend: [7_250_000, 10_250_000, 13_000_000, 9_500_000, 7_750_000, 8_550_000] };
    case "fuel_flags": return { kind: "kpi", value: 1, format: "count", tone: "bad", sub: L("dash.sub.last45") };
    case "fines_to_nominate": return { kind: "kpi", value: 2, format: "count", tone: "warn", sub: L("dash.sub.nextDeadline").replace("{when}", "3 d") };
    case "problems_trend": return series(locale, [4, 7, 3, 6, 5, 2], "count");
    case "spend_trend": return series(locale, [2_400_000, 1_200_000, 3_100_000, 1_900_000, 2_075_000, 1_845_000], "rands");
    case "fuel_trend": return series(locale, [2_900, 4_100, 5_200, 3_800, 3_100, 3_420], "litres");
    case "problems_by_urgency":
      return { kind: "breakdown", format: "count", statusColoured: true, items: [
        { key: "stopped", label: L("urgency.stopped"), value: 2, status: "bad" },
        { key: "limping", label: L("urgency.limping"), value: 1, status: "warn" },
        { key: "can_work", label: L("urgency.can_work"), value: 2, status: "ok" }] };
    case "service_status":
      return { kind: "breakdown", format: "count", statusColoured: true, items: [
        { key: "overdue", label: L("ui.statusOverdue"), value: 2, status: "bad" },
        { key: "due_soon", label: L("ui.statusDueSoon"), value: 3, status: "warn" },
        { key: "ok", label: L("ui.statusOk"), value: 6, status: "ok" },
        { key: "none", label: L("dash.noPlan"), value: 1, status: "neutral" }] };
    case "fleet_status":
      return { kind: "breakdown", format: "count", statusColoured: true, items: [
        { key: "active", label: L("machineStatus.active"), value: 9, status: "ok" },
        { key: "standby", label: L("machineStatus.standby"), value: 1, status: "neutral" },
        { key: "in_workshop", label: L("machineStatus.in_workshop"), value: 1, status: "warn" },
        { key: "out_of_service", label: L("machineStatus.out_of_service"), value: 1, status: "bad" }] };
    case "job_cards_by_status":
      return { kind: "breakdown", format: "count", statusColoured: false, items: ["reported", "open", "in_progress", "waiting_parts"].map((k, i) =>
        ({ key: k, label: L(`jobStatus.${k}`), value: [1, 2, 3, 1][i] })) };
    case "spend_by_type":
      return { kind: "breakdown", format: "rands", statusColoured: false, items: ["scheduled_service", "repair", "inspection", "other"].map((k, i) =>
        ({ key: k, label: L(`jobType.${k}`), value: [4_200_000, 3_100_000, 600_000, 450_000][i] })) };
    case "top_cost_machines":
      return { kind: "breakdown", format: "rands", statusColoured: false, items: [
        { key: "a", label: "Tractor 1", value: 2_400_000 }, { key: "b", label: "Truck 2", value: 1_650_000 },
        { key: "c", label: "Harvester", value: 1_200_000 }, { key: "d", label: "Bakkie 4", value: 640_000 }] };
    case "attention":
    case "latest_problems":
      return { kind: "list", more: 0, empty: "", rows: [
        row("1", "Tractor 1", `${L("urgency.stopped")} · 2 d`, { label: L("urgency.stopped"), tone: "danger" }),
        row("2", "Truck 2", `${L("ui.statusOverdue")} · 5 d`, { label: L("ui.statusOverdue"), tone: "danger" }),
        row("3", "Harvester", `${L("urgency.limping")} · 1 w`, { label: L("urgency.limping"), tone: "warning" })] };
    case "upcoming_services":
      return { kind: "list", more: 0, empty: "", rows: [
        row("1", "Tractor 1", "250 h · 12 Nov", { label: L("ui.statusDueSoon"), tone: "warning" }),
        row("2", "Bakkie 4", "15 000 km · 2 Dec", { label: L("ui.statusOk"), tone: "ok" })] };
    case "stale_meters":
    case "in_workshop":
    case "expiring_papers":
      return { kind: "list", more: 0, empty: "", rows: [row("1", "Tractor 1", "4 820 h · 29 Jul"), row("2", "Truck 2", "182 400 km · 12 Aug")] };
  }
  return null;
}
