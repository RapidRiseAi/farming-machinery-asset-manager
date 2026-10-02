import { t, type Lang } from "@/lib/i18n";
import { SubmitButton } from "@/components/ui/submit-button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
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

/** The four grants, in the order the dialog asks about them. */
function grantsOf(access: PartnerAccess) {
  return [
    { name: "see_all_vehicles", on: access.see_all_vehicles, key: "vehicles" },
    { name: "see_service_history", on: access.see_service_history, key: "history" },
    { name: "see_costs", on: access.see_costs, key: "costs" },
    { name: "see_team", on: access.see_team, key: "team" },
  ] as const;
}

/**
 * One quiet line saying what a connected contractor can see (F16).
 *
 * This used to be a card per contractor with four live checkboxes and a save button,
 * stacked above the directory, so a farm with seven contractors opened on 28 controls
 * and every connected contractor appeared twice. The screen now states the grant, and
 * changing it is a dialog behind the partner's own actions.
 */
export function PartnerAccessSummary({
  access,
  locale,
  className,
}: {
  access: PartnerAccess;
  locale: Lang;
  className?: string;
}) {
  const granted = grantsOf(access).filter((g) => g.on);
  return (
    <p className={className ?? "text-sm text-sand-600"}>
      {granted.length === 0
        ? t("access.summaryNone", locale)
        : t("access.summaryExtra", locale).replace(
            "{list}",
            granted.map((g) => t(`access.${g.key}`, locale)).join(", "),
          )}
    </p>
  );
}

/**
 * "What they can see", as a row in the partner's ActionMenu.
 *
 * Written as four plain sentences rather than four permission names, because the person
 * deciding is a farmer, not an administrator. The dialog states up front what they can
 * already see without any of them, otherwise "all off" reads as "they can see nothing",
 * which would be wrong and would make the whole thing look broken.
 *
 * The one thing with no switch is the farm's other contractors, and the dialog says so.
 * That is a competitor list; there is no version of a repair job that needs it.
 */
export function PartnerAccessDialog({
  access,
  locale,
  closeLabel,
  cancelLabel,
}: {
  access: PartnerAccess;
  locale: Lang;
  closeLabel: string;
  cancelLabel: string;
}) {
  const id = (name: string) => `acc_${access.workshop_id}_${name}`;
  return (
    <DialogForm
      triggerLook="menuItem"
      trigger={t("access.title", locale)}
      title={t("access.titleFor", locale).replace("{name}", access.name)}
      description={t("access.baseline", locale)}
      closeLabel={closeLabel}
      size="md"
    >
      <form action={setPartnerAccess}>
        <input type="hidden" name="workshop_id" value={access.workshop_id} />
        <input type="hidden" name="farm_id" value={access.farm_id} />
        <DialogFields columns={1} className="gap-1">
          {grantsOf(access).map((g) => (
            <Checkbox
              key={g.name}
              id={id(g.name)}
              name={g.name}
              defaultChecked={g.on}
              label={t(`access.${g.key}`, locale)}
              hint={t(`access.${g.key}Hint`, locale)}
            />
          ))}
        </DialogFields>
        <p className="mt-3 text-sm text-sand-500">{t("access.neverPartners", locale)}</p>
        <DialogActions cancelLabel={cancelLabel}>
          <SubmitButton variant="primary">{t("access.save", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );
}

/** Disconnect, as the last row in the partner's ActionMenu. Access stops at once. */
export function PartnerDisconnect({
  access,
  locale,
  closeLabel,
}: {
  access: PartnerAccess;
  locale: Lang;
  closeLabel: string;
}) {
  return (
    <ConfirmDialog
      action={revokePartnerAccess}
      triggerLook="menuItem"
      triggerLabel={t("access.disconnect", locale)}
      title={t("access.disconnectTitle", locale)}
      intro={t("access.disconnectBody", locale).replace("{name}", access.name)}
      consequences={[t("access.disconnectConsequence", locale)]}
      footnote={t("access.disconnectFootnote", locale)}
      confirmLabel={t("access.disconnect", locale)}
      cancelLabel={t("common.cancel", locale)}
      closeLabel={closeLabel}
    >
      <input type="hidden" name="workshop_id" value={access.workshop_id} />
      <input type="hidden" name="farm_id" value={access.farm_id} />
    </ConfirmDialog>
  );
}
