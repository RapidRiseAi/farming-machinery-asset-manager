/**
 * The board a person starts with, and gets back from "Reset".
 *
 * Built for what a farm owner asks first thing in the morning, in this order: is
 * anything broken or standing still, is anything overdue, what is the fleet doing,
 * what has it cost, and what is coming up. A person who cannot see money gets the
 * same board with its money widgets swapped for working ones, not holes; a mechanic
 * gets a workshop board. Widgets the farm cannot have are left out (`widgetBlock`).
 */
import { compact, type LayoutItem } from "./layout";
import { WIDGET_BY_TYPE, widgetBlock, type WidgetAccess } from "./widgets";

type Slot = { type: string; x: number; y: number; w: number; h: number; or?: string[] };

const OWNER: Slot[] = [
  { type: "open_problems", x: 0, y: 0, w: 3, h: 2 },
  { type: "machines_with_problems", x: 3, y: 0, w: 3, h: 2 },
  { type: "service_overdue", x: 6, y: 0, w: 3, h: 2 },
  { type: "spend_month", x: 9, y: 0, w: 3, h: 2, or: ["open_job_cards"] },
  { type: "attention", x: 0, y: 2, w: 8, h: 6 },
  { type: "fleet_status", x: 8, y: 2, w: 4, h: 3 },
  { type: "service_status", x: 8, y: 5, w: 4, h: 3 },
  { type: "spend_trend", x: 0, y: 8, w: 6, h: 4, or: ["job_cards_by_status"] },
  { type: "problems_trend", x: 6, y: 8, w: 6, h: 4 },
  { type: "upcoming_services", x: 0, y: 12, w: 6, h: 4, or: ["stale_meters"] },
  { type: "latest_problems", x: 6, y: 12, w: 6, h: 4 },
  { type: "fuel_trend", x: 0, y: 16, w: 6, h: 4, or: ["in_workshop"] },
  { type: "expiring_papers", x: 6, y: 16, w: 6, h: 4 },
];

const WORKSHOP: Slot[] = [
  { type: "open_problems", x: 0, y: 0, w: 3, h: 2 },
  { type: "machines_stopped", x: 3, y: 0, w: 3, h: 2 },
  { type: "open_job_cards", x: 6, y: 0, w: 3, h: 2 },
  { type: "service_overdue", x: 9, y: 0, w: 3, h: 2 },
  { type: "attention", x: 0, y: 2, w: 8, h: 6 },
  { type: "in_workshop", x: 8, y: 2, w: 4, h: 6 },
  { type: "latest_problems", x: 0, y: 8, w: 6, h: 4 },
  { type: "upcoming_services", x: 6, y: 8, w: 6, h: 4, or: ["stale_meters"] },
  { type: "stale_meters", x: 0, y: 12, w: 6, h: 4 },
  { type: "job_cards_by_status", x: 6, y: 12, w: 6, h: 4 },
];

export function defaultLayout(role: string, access: WidgetAccess): LayoutItem[] {
  const slots = role === "mechanic" ? WORKSHOP : OWNER;
  const used = new Set<string>();
  const items: LayoutItem[] = [];
  for (const slot of slots) {
    const type = [slot.type, ...(slot.or ?? [])].find((t) => {
      const def = WIDGET_BY_TYPE.get(t);
      return def && !used.has(t) && !widgetBlock(def, access);
    });
    if (!type) continue;
    used.add(type);
    items.push({ id: `${type.replace(/_/g, "")}-1`, type, x: slot.x, y: slot.y, w: slot.w, h: slot.h, settings: {} });
  }
  return compact(items);
}
