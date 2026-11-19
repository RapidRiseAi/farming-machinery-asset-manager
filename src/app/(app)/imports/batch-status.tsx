import { t, type Lang } from "@/lib/i18n";
import { StatusBadge } from "@/components/ui/badge";

export type BatchStatusValue = "review" | "confirmed" | "cancelled";

/** An import's state in shape, word and colour (never colour alone). */
export function BatchStatus({ status, locale }: { status: BatchStatusValue; locale: Lang }) {
  if (status === "confirmed") return <StatusBadge tone="ok" shape="check" label={t("imports.status.confirmed", locale)} />;
  if (status === "cancelled") return <StatusBadge tone="neutral" shape="dash" label={t("imports.status.cancelled", locale)} />;
  return <StatusBadge tone="warning" shape="triangle" label={t("imports.status.review", locale)} />;
}
