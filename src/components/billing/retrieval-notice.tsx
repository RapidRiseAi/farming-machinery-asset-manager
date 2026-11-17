import type { FarmLifecycle } from "@/lib/billing/service";
import { shortDate } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";

/**
 * Who may still read a stopped business, and until when (decisions 38 and 41, 20261115120000).
 * The owner reads and exports for 90 days; the team cannot use FLEETWISE at all; once the 90
 * days are over nobody reads until it is paid or started again. Said from the lifecycle the
 * database answers, so the screen and the rule cannot disagree.
 */
export function RetrievalNotice({
  life,
  isOwner,
  locale,
}: {
  life: FarmLifecycle | null;
  isOwner: boolean;
  locale: Lang;
}) {
  if (!life) return null;
  if (life.state === "retrieval") {
    return (
      <p className="mt-4 rounded-lg border border-callout-warn-edge bg-callout-warn-bg p-3 text-sm text-ink">
        {isOwner
          ? life.retrieval_ends_on
            ? t("lifecycle.ownerUntil", locale).replace("{date}", shortDate(life.retrieval_ends_on, locale))
            : t("lifecycle.ownerOnly", locale)
          : t("lifecycle.staffOwnerOnly", locale)}
      </p>
    );
  }
  if (life.state === "closed" && life.reason !== "rapid_rise" && life.retrieval_ends_on) {
    return (
      <p className="mt-4 rounded-lg border border-callout-danger-edge bg-callout-danger-bg p-3 text-sm text-ink">
        {t(life.reason === "unpaid" ? "lifecycle.readingEndedUnpaid" : "lifecycle.readingEndedCancelled", locale).replace(
          "{date}",
          shortDate(life.retrieval_ends_on, locale),
        )}
      </p>
    );
  }
  return null;
}

/** May this person export the records now: the owner, while reading is open. */
export function mayExport(life: FarmLifecycle | null, isOwner: boolean): boolean {
  if (!life) return isOwner;
  if (life.state === "active" || life.state === "grace") return true;
  if (life.state === "pending") return false;
  if (!isOwner) return false;
  return life.state === "retrieval" || life.reason === "rapid_rise";
}
