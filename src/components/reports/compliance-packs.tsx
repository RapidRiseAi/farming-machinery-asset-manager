import { t, type Lang } from "@/lib/i18n";
import { buttonVariants } from "@/components/ui/button";

/**
 * The fleet GLOBALG.A.P. / SIZA pack link for the reports header (FR-13.4).
 *
 * One anchor, no client JS. Split out of the reports page so the pack feature owns its
 * own markup; the page keeps one line.
 *
 * The route behind it is Professional+ (`advanced_reports`) — the same gate the reports
 * page itself carries, so a farm that can see this button can always use it. The
 * per-vehicle packs on machine detail are core on every plan, which is where the actual
 * audit evidence lives; see the note at the top of
 * src/app/api/packs/fleet-compliance/route.ts.
 */
export function FleetCompliancePackLink({ locale }: { locale: Lang }) {
  return (
    <a
      href="/api/packs/fleet-compliance"
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      {t("reports.auditPack", locale)} ↓
    </a>
  );
}
