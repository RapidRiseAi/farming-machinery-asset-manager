import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Fact, FactList } from "@/components/ui/facts";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/components/ui/cn";
import type { StorageStatus } from "@/lib/billing/storage";
import { shortDate } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { gigabytes, minimumCeilingCents, percentUsed } from "@/lib/storage-allowance";

type Action = (formData: FormData) => Promise<void>;

const gb = (bytes: number, locale: Lang) =>
  t("billing.storageGb", locale).replace("{n}", gigabytes(bytes).toLocaleString(locale === "af" ? "af-ZA" : "en-ZA"));

/**
 * The customer's pooled attachment storage (20261118120000): how full it is, where the
 * allowance comes from, the paid 10 GB blocks and what they cost a month (monthly even with
 * annual software), a scheduled reduction, and, for the owner, changing blocks (an A2 quote,
 * priced before anything is accepted) and the automatic setting (off by default, with a
 * monthly ceiling that counts the blocks held). Everyone with access sees how full it is; the
 * money is the payer's (public.storage_pool_status leaves it out for anybody else).
 */
export function StorageCard({
  status,
  locale,
  canChange,
  request,
  saveAuto,
}: {
  status: StorageStatus;
  locale: Lang;
  canChange: boolean;
  request: Action;
  saveAuto: Action;
}) {
  const percent = percentUsed(status.used_bytes, status.total_bytes);
  const money = status.money;
  const levelKey =
    status.level === "full" ? "billing.storageLevelFull" : status.level === "95" ? "billing.storageLevel95" : status.level === "80" ? "billing.storageLevel80" : null;
  const reductionPending = status.next.blocks !== status.blocks && status.next.blocks_on;
  const renewalSmaller = status.next.included_bytes < status.included_bytes;

  return (
    <Card id="storage">
      <CardHeader>
        <CardTitle>{t("billing.storageTitle", locale)}</CardTitle>
      </CardHeader>
      <div className="flex flex-col gap-1">
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-sand-100"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t("billing.storageTitle", locale)}
        >
          <div
            className={cn("h-full rounded-full", status.level === "ok" ? "bg-brand-600" : "bg-status-overdue")}
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-sm text-sand-800">
          {t("billing.storageUsed", locale)
            .replace("{used}", gb(status.used_bytes, locale))
            .replace("{total}", gb(status.total_bytes, locale))
            .replace("{percent}", String(percent))}
        </p>
        {levelKey ? <p className="text-sm font-semibold text-status-overdue">{t(levelKey, locale)}</p> : null}
      </div>

      <FactList>
        <Fact
          label={t("billing.storageIncluded", locale)}
          value={t("billing.storageIncludedValue", locale)
            .replace("{gb}", gb(status.included_bytes, locale))
            .replace("{full}", String(status.full_spaces))
            .replace("{equipment}", String(status.equipment_spaces))}
        />
        <Fact
          label={t("billing.storageBlocks", locale)}
          value={status.blocks > 0
            ? t("billing.storageBlocksValue", locale).replace("{n}", String(status.blocks))
            : t("billing.storageBlocksNone", locale)}
        />
        {money ? (
          <Fact
            label={t("billing.storageMonthlyLabel", locale)}
            value={money.monthly_cents > 0 ? rands(money.monthly_cents) : t("billing.quoteNoCharge", locale)}
          />
        ) : null}
        {reductionPending ? (
          <Fact
            label={t("billing.storageFromDate", locale).replace("{date}", shortDate(status.next.blocks_on, locale))}
            value={t("billing.storageBlocksValue", locale).replace("{n}", String(status.next.blocks))}
          />
        ) : null}
        {renewalSmaller ? (
          <Fact label={t("billing.storageAtRenewal", locale)} value={gb(status.next.total_bytes, locale)} />
        ) : null}
      </FactList>

      <p className="mt-3 text-sm leading-relaxed text-sand-700">{t("billing.storagePoolNote", locale)}</p>
      {money ? (
        <p className="mt-2 text-sm leading-relaxed text-sand-700">
          {t(money.billing_period === "annual" ? "billing.storageAnnualNote" : "billing.storageMonthlyNote", locale)
            .replace("{price}", rands(money.block_monthly_cents))}
        </p>
      ) : null}
      <p className="mt-2 text-sm leading-relaxed text-sand-700">{t("billing.storageTransferNote", locale)}</p>
      {money ? (
        <p className="mt-2 text-sm leading-relaxed text-sand-700">
          {money.auto_blocks && money.auto_ceiling_cents != null
            ? t("billing.storageAutoOnLine", locale).replace("{ceiling}", rands(money.auto_ceiling_cents))
            : t("billing.storageAutoOffLine", locale)}
        </p>
      ) : null}

      {money && canChange ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <DialogForm
            trigger={t("billing.storageChange", locale)}
            title={t("billing.storageChangeTitle", locale)}
            description={t("billing.storageChangeHelp", locale).replace("{price}", rands(money.block_monthly_cents))}
            closeLabel={t("ui.close", locale)}
            triggerVariant="secondary"
          >
            <form action={request}>
              <input type="hidden" name="change" value="storage" />
              <DialogFields>
                <Field label={t("billing.storageBlocksField", locale)} htmlFor="storage-blocks">
                  <Input
                    id="storage-blocks"
                    name="blocks"
                    inputMode="numeric"
                    required
                    defaultValue={String(status.blocks + 1)}
                  />
                </Field>
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <SubmitButton>{t("billing.quoteReview", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
          <DialogForm
            trigger={t("billing.storageAutoChange", locale)}
            title={t("billing.storageAutoTitle", locale)}
            description={t("billing.storageAutoHelp", locale)
              .replace("{price}", rands(money.block_monthly_cents))
              .replace("{min}", rands(minimumCeilingCents(status.blocks, money.block_monthly_cents)))}
            closeLabel={t("ui.close", locale)}
            triggerVariant="secondary"
          >
            <form action={saveAuto}>
              <DialogFields>
                <Checkbox name="auto" value="1" defaultChecked={money.auto_blocks} label={t("billing.storageAutoField", locale)} />
                <Field label={t("billing.storageCeilingField", locale)} htmlFor="storage-ceiling">
                  <Input
                    id="storage-ceiling"
                    name="ceiling"
                    inputMode="decimal"
                    defaultValue={money.auto_ceiling_cents != null ? String(money.auto_ceiling_cents / 100) : ""}
                  />
                </Field>
                <Checkbox
                  name="accept"
                  value="1"
                  label={t("billing.storageAutoAccept", locale).replace("{price}", rands(money.block_monthly_cents))}
                />
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <SubmitButton>{t("common.save", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        </div>
      ) : null}
    </Card>
  );
}
