import Link from "next/link";
import { t, type Lang } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { readFinanceBook } from "@/lib/asset-finance-read";
import { createContract, createFinanceAgreement } from "@/app/(app)/finance/actions";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DialogActions, DialogForm } from "@/components/ui/dialog-form";
import { SubmitButton } from "@/components/ui/submit-button";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { PlusIcon } from "@/components/ui/icons";

import { AgreementCard, ContractCard } from "./finance-cards";
import { AgreementFields, ContractFields } from "./finance-fields";

/**
 * The Finance section of a machine's Costs tab: its finance agreements and the leases,
 * rentals and service contracts on it. Replaces the five read-only finance fields the
 * machine record used to carry (moved into agreements by 20261028110700).
 *
 * The caller renders this only for someone `can_view_farm_finance` admits (owners and
 * managers); RLS would return nothing to anyone else anyway, and an empty section that
 * says "no finance" to a mechanic would be a lie.
 */
export async function MachineFinanceSection({
  machineId,
  farmId,
  locale,
  today,
}: {
  machineId: string;
  farmId: string;
  locale: Lang;
  today: string;
}) {
  const L = (key: string) => t(`assetFinance.${key}`, locale);
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const supabase = await createClient();
  const book = await readFinanceBook(supabase, farmId, today, machineId);
  const back = `/machines/${machineId}`;
  const docsFor = (id: string) => book.docs.filter((d) => d.parent_id === id);

  const addAgreement = (
    <DialogForm
      trigger={L("addAgreement")}
      triggerIcon={<PlusIcon />}
      triggerVariant="secondary"
      triggerSize="sm"
      title={L("addAgreementTitle")}
      description={L("addAgreementBody")}
      closeLabel={closeLabel}
      size="lg"
    >
      <form action={createFinanceAgreement}>
        <RequestIdInput action="finance:create-agreement" />
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="machine_id" value={machineId} />
        <AgreementFields locale={locale} idPrefix={`na-${machineId}`} today={today} />
        <DialogActions cancelLabel={cancelLabel} note={L("exVatNote")}>
          <SubmitButton variant="primary">{L("addAgreement")}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  const addContract = (
    <DialogForm
      trigger={L("addContract")}
      triggerIcon={<PlusIcon />}
      triggerVariant="secondary"
      triggerSize="sm"
      title={L("addContractTitle")}
      description={L("addContractBody")}
      closeLabel={closeLabel}
      size="lg"
    >
      <form action={createContract}>
        <RequestIdInput action="finance:create-contract" />
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="farm_id" value={farmId} />
        <ContractFields locale={locale} idPrefix={`nc-${machineId}`} fixedMachineId={machineId} today={today} />
        <DialogActions cancelLabel={cancelLabel} note={L("exVatNote")}>
          <SubmitButton variant="primary">{L("addContract")}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  const empty = book.agreements.length === 0 && book.contracts.length === 0;

  return (
    <Card flush>
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <CardHeader>
          <CardTitle>{L("machineSectionTitle")}</CardTitle>
        </CardHeader>
        <p className="text-xs text-sand-500">{L("machineSectionHint")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {addAgreement}
          {addContract}
        </div>
      </div>
      {empty ? (
        <p className="p-4 text-sm text-sand-500 sm:p-5">{L("machineSectionEmpty")}</p>
      ) : (
        <ul className="mt-2 divide-y divide-sand-200">
          {book.agreements.map((a) => (
            <AgreementCard
              key={a.id}
              agreement={a}
              instalments={book.instalments.filter((i) => i.agreement_id === a.id)}
              summary={book.summaries.get(a.id)}
              locale={locale}
              back={back}
              today={today}
              docs={docsFor(a.id)}
            />
          ))}
          {book.contracts.map((c) => (
            <ContractCard
              key={c.id}
              contract={c}
              fixedMachineId={machineId}
              locale={locale}
              back={back}
              today={today}
              docs={docsFor(c.id)}
            />
          ))}
        </ul>
      )}
      <div className="border-t border-sand-100 p-4 sm:p-5">
        <Link href="/finance" className="inline-flex min-h-12 items-center text-sm font-medium text-brand-ink underline">
          {L("allFinanceLink")}
        </Link>
      </div>
    </Card>
  );
}
