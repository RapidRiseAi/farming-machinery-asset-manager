import { t, type Lang } from "@/lib/i18n";
import { buttonVariants } from "@/components/ui/button";
import { menuItemClass } from "@/components/ui/menu-item";
import { DownloadIcon } from "@/components/ui/icons";
import { DownloadLink } from "@/components/ui/download-link";
import { downloadLabels } from "@/lib/interaction-labels";

/**
 * The fleet GLOBALG.A.P. / SIZA pack link (FR-13.4).
 *
 * One anchor, no client JS. Split out of the reports page so the pack feature owns its
 * own markup; the page keeps one line. `look="menuItem"` renders it as a row of the
 * reports Export menu, which is where it lives now; the button look stays for any other
 * caller.
 *
 * The route behind it is Professional+ (`advanced_reports`), the same gate the reports
 * page itself carries, so a farm that can see this link can always use it. The
 * per-vehicle packs on machine detail are core on every plan, which is where the actual
 * audit evidence lives; see the note at the top of
 * src/app/api/packs/fleet-compliance/route.ts.
 */
export function FleetCompliancePackLink({
  locale,
  look = "button",
}: {
  locale: Lang;
  look?: "button" | "menuItem";
}) {
  if (look === "menuItem") {
    return (
      <DownloadLink href="/api/packs/fleet-compliance" className={menuItemClass()} labels={downloadLabels(locale)}>
        <DownloadIcon className="shrink-0 text-base text-sand-500" />
        {t("reports.auditPack", locale)}
      </DownloadLink>
    );
  }
  return (
    <DownloadLink
      href="/api/packs/fleet-compliance"
      className={buttonVariants({ variant: "secondary", size: "sm" })}
      labels={downloadLabels(locale)}
    >
      {t("reports.auditPack", locale)} ↓
    </DownloadLink>
  );
}
