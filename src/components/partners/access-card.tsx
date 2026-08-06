import { t, type Lang } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { setPartnerAccess, revokePartnerAccess } from "@/app/(app)/partners/actions";

export type PartnerAccess = {
  workshop_id: string;
  farm_id: string;
  name: string;
  see_all_vehicles: boolean;
  see_service_history: boolean;
  see_costs: boolean;
  see_team: boolean;
};

/**
 * What one connected contractor can see of this farm (F16).
 *
 * Written as four plain sentences rather than four permission names, because the person
 * deciding is a farmer, not an administrator. Each one says what the contractor will be
 * able to look at, and the card states up front what they can already see without any of
 * them — otherwise "all off" reads as "they can see nothing", which would be wrong and
 * would make the whole thing look broken.
 *
 * The one thing with no switch is the farm's other contractors, and the card says so.
 * That is a competitor list; there is no version of a repair job that needs it.
 */
export function PartnerAccessCard({ access, locale }: { access: PartnerAccess; locale: Lang }) {
  const row = "flex items-start gap-3 rounded-lg border border-sand-200 p-3";
  const check = "mt-0.5 h-5 w-5 shrink-0 rounded border-sand-300 text-brand-600";

  const grants = [
    { name: "see_all_vehicles", on: access.see_all_vehicles, key: "vehicles" },
    { name: "see_service_history", on: access.see_service_history, key: "history" },
    { name: "see_costs", on: access.see_costs, key: "costs" },
    { name: "see_team", on: access.see_team, key: "team" },
  ] as const;

  const granted = grants.filter((g) => g.on).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t("access.title", locale)} — {access.name}
          <Badge tone={granted === 0 ? "ok" : "info"} className="ml-2 align-middle">
            {granted === 0 ? t("access.minimum", locale) : t("access.nGranted", locale).replace("{n}", String(granted))}
          </Badge>
        </CardTitle>
      </CardHeader>

      <p className="mb-3 text-sm text-sand-600">{t("access.baseline", locale)}</p>

      <form action={setPartnerAccess} className="flex flex-col gap-2">
        <input type="hidden" name="workshop_id" value={access.workshop_id} />
        <input type="hidden" name="farm_id" value={access.farm_id} />

        {grants.map((g) => (
          <label key={g.name} className={row}>
            <input type="checkbox" name={g.name} defaultChecked={g.on} className={check} />
            <span className="min-w-0 text-sm">
              <span className="font-medium text-sand-900">{t(`access.${g.key}`, locale)}</span>
              <span className="block text-sand-600">{t(`access.${g.key}Hint`, locale)}</span>
            </span>
          </label>
        ))}

        <p className="mt-1 text-sm text-sand-500">{t("access.neverPartners", locale)}</p>
        <SubmitButton variant="secondary" className="mt-1 self-start">
          {t("access.save", locale)}
        </SubmitButton>
      </form>

      <div className="mt-3 border-t border-sand-100 pt-3">
        <ConfirmDialog
          action={revokePartnerAccess}
          triggerLabel={t("access.disconnect", locale)}
          triggerVariant="ghost"
          triggerSize="sm"
          title={t("access.disconnectTitle", locale)}
          intro={t("access.disconnectBody", locale).replace("{name}", access.name)}
          consequences={[t("access.disconnectConsequence", locale)]}
          footnote={t("access.disconnectFootnote", locale)}
          confirmLabel={t("access.disconnect", locale)}
          cancelLabel={t("common.cancel", locale)}
          closeLabel={t("ui.close", locale)}
        >
          <input type="hidden" name="workshop_id" value={access.workshop_id} />
          <input type="hidden" name="farm_id" value={access.farm_id} />
        </ConfirmDialog>
      </div>
    </Card>
  );
}
