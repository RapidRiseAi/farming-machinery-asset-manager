import { StatusBadge, look, type StatusLook } from "@/components/ui/badge";
import { t, type Lang } from "@/lib/i18n";

/**
 * The purchase-order lifecycle badge (G16).
 *
 * Built on the shared `StatusBadge`, so an order's state carries the same three
 * independent signals as every other status in the product — a shape you can tell apart in
 * silhouette, a word in plain language, and a colour — and none of the three is load
 * bearing on its own.
 *
 * The map lives here rather than in `components/ui/badge.tsx` alongside the other nine
 * only because that file belongs to another workstream this session; it is the same shape
 * as `DOC_LOOK` and belongs next to it. NOTES.md asks for the move.
 *
 * `closed` and `cancelled` are deliberately NOT the same glyph even though both are grey
 * and both mean "nothing more will happen". One is finished business and the other never
 * happened, and a partner scanning the list needs to tell them apart without reading.
 */
const PO_LOOK: Record<string, StatusLook> = {
  draft: { tone: "neutral", shape: "ring" }, // ○ not with the supplier yet
  sent: { tone: "info", shape: "clock" }, // ◔ waiting on somebody else
  part_received: { tone: "warning", shape: "half" }, // ◐ some of it is here
  received: { tone: "ok", shape: "check" }, // ✓ it all arrived
  closed: { tone: "neutral", shape: "check" }, // ✓ dealt with, no longer live
  cancelled: { tone: "neutral", shape: "dash" }, // — never happened
};

export function OrderStatus({
  value,
  locale,
  size = "sm",
  className,
}: {
  value: string | null | undefined;
  locale: Lang;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!value) return null;
  const l = look(PO_LOOK, value);
  return (
    <StatusBadge
      label={t(`po.status.${value}`, locale)}
      tone={l.tone}
      shape={l.shape}
      size={size}
      className={className}
    />
  );
}
