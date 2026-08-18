import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop, checkWorkshopEntitlement } from "@/lib/auth";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { supplierPositions, EMPTY_POSITION, type Supplier } from "@/lib/suppliers";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { GetStarted } from "@/components/ui/empty-state";
import { Field, TextField, TextareaField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon } from "@/components/ui/icons";
import { createSupplier, updateSupplier, setSupplierActive, deleteSupplier } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The supplier book (G18).
 *
 * Before this screen a supplier was a string typed onto an invoice, which meant three
 * things at once: the payables ageing split one business across every spelling of its name,
 * an account number or a payment term had nowhere to live, and a typo created a creditor
 * that would sit on the report for ever because nothing would ever be captured against that
 * spelling again.
 *
 * The list leads with what is OWED rather than with what has been spent. "Who do I owe, and
 * how much" is the question a supplier list gets opened for; total spend is a year-end
 * question and lives on /money.
 */
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  // Suppliers belong to a workshop, not a farm — a farm reading its contractor's supplier
  // list and terms would be reading the margin behind every quote it is given (F16).
  if (profile.role !== "workshop") redirect("/documents");
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  // Running the books here is the `books` product (0492). Denied BEFORE any query runs,
  // so a partner without it never causes the data to be read, let alone rendered.
  const gate = await checkWorkshopEntitlement("financials", profile);
  if (!gate.allowed) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <UpgradeNotice
          feature="financials"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </div>
    );
  }

  const supabase = await createClient();
  const [{ data: supplierData }, { data: expenseData }] = await Promise.all([
    supabase
      .from("suppliers")
      .select("*")
      .is("deleted_at", null)
      .order("active", { ascending: false })
      .order("name", { ascending: true }),
    // Only the four columns the rollup needs. RLS scopes both queries to this workshop, so
    // neither carries a workshop filter of its own.
    supabase
      .from("partner_expenses")
      .select("supplier_id, amount_cents, vat_cents, paid_on")
      .is("deleted_at", null),
  ]);

  const suppliers = (supplierData ?? []) as Supplier[];
  const expenses = (expenseData ?? []) as {
    supplier_id: string | null;
    amount_cents: number;
    vat_cents: number;
    paid_on: string | null;
  }[];

  const positions = supplierPositions(expenses);
  const owedTotal = suppliers.reduce((s, r) => s + (positions.get(r.id)?.owed_cents ?? 0), 0);

  // Invoices still filed under a typed name because nobody has created that supplier. Shown
  // as a count rather than hidden: those are exactly the rows that will keep fragmenting the
  // ageing until somebody files them, and 0481 deliberately will not invent them.
  const unfiledCount = expenses.filter((e) => !e.supplier_id).length;

  const activeCount = suppliers.filter((s) => s.active).length;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("supplier.title", locale)}</h1>
        <p className="text-sm text-sand-600">{t("supplier.lead", locale)}</p>
      </div>

      <Flash
        tone="error"
        message={
          sp.error === "duplicate"
            ? t("supplier.errDuplicate", locale)
            : sp.error === "need-name"
              ? t("supplier.errNeedName", locale)
              : sp.error === "not-found"
                ? t("supplier.errNotFound", locale)
                : sp.error
        }
      />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />
      <Flash tone="success" message={sp.deleted ? t("supplier.deletedFlash", locale) : undefined} />

      {suppliers.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label={t("supplier.statCount", locale)} value={String(activeCount)} />
          <Stat
            label={t("supplier.statOwed", locale)}
            value={rands(owedTotal)}
            tone={owedTotal > 0 ? "due" : "default"}
          />
          <Stat
            label={t("supplier.statUnfiled", locale)}
            value={String(unfiledCount)}
            delta={unfiledCount > 0 ? t("supplier.statUnfiledHint", locale) : undefined}
          />
        </div>
      ) : null}

      {/* Add one. Name is the only thing insisted on; everything else is what the workshop
          happens to know today, and demanding a VAT number to file a supplier is how a
          screen stops being used. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("supplier.addTitle", locale)}</CardTitle>
        </CardHeader>
        <form action={createSupplier} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="name" label={t("supplier.name", locale)} required />
            <TextField name="contact_person" label={t("supplier.contact", locale)} hint={t("supplier.contactHint", locale)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="phone" type="tel" label={t("supplier.phone", locale)} />
            <TextField name="email" type="email" label={t("supplier.email", locale)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField name="vat_number" label={t("supplier.vatNumber", locale)} hint={t("supplier.vatNumberHint", locale)} />
            <TextField name="account_number" label={t("supplier.accountNumber", locale)} hint={t("supplier.accountNumberHint", locale)} />
            <Field label={t("supplier.terms", locale)} htmlFor="new_terms" hint={t("supplier.termsHint", locale)}>
              <Input id="new_terms" name="payment_terms_days" inputMode="numeric" />
            </Field>
          </div>
          <TextField name="address" label={t("supplier.address", locale)} />
          <TextareaField name="notes" label={t("supplier.notes", locale)} rows={2} />
          <SubmitButton className="self-start">{t("supplier.save", locale)}</SubmitButton>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("supplier.listTitle", locale)}</CardTitle>
        </CardHeader>

        {suppliers.length === 0 ? (
          <GetStarted title={t("supplier.emptyTitle", locale)} hint={t("supplier.emptyBody", locale)} />
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100">
            {suppliers.map((row) => {
              const pos = positions.get(row.id) ?? EMPTY_POSITION;
              return (
                <li key={row.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sand-900">
                        {/* The name opens the account: statement, ageing and the remittance
                            advice for a payment run (G25). Until this link existed /money
                            could say "you owe them R80 500" and nothing could open that
                            line. A plain link, not a wrapper around the whole row — the row
                            already contains its own forms and a nested interactive element
                            is the invalid HTML that threw React #418 on the machines list. */}
                        <Link
                          href={`/suppliers/${row.id}`}
                          className="focus-ring rounded underline-offset-2 hover:underline"
                        >
                          {row.name}
                        </Link>{" "}
                        {row.active ? null : <Badge tone="neutral">{t("supplier.inactive", locale)}</Badge>}
                      </p>
                      <p className="text-sm text-sand-600">
                        {[row.contact_person, row.phone, row.email].filter(Boolean).join(" · ") || "—"}
                      </p>
                      <p className="text-xs text-sand-500">
                        {[
                          row.payment_terms_days != null
                            ? `${t("supplier.termsShort", locale)} ${row.payment_terms_days}`
                            : null,
                          row.account_number ? `${t("supplier.accountShort", locale)} ${row.account_number}` : null,
                          row.vat_number ? `${t("supplier.vatShort", locale)} ${row.vat_number}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || t("supplier.noTerms", locale)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular-nums text-sand-900">
                        {pos.owed_cents > 0 ? rands(pos.owed_cents) : t("supplier.nothingOwed", locale)}
                      </p>
                      <p className="text-xs text-sand-500">
                        {pos.invoices} {t("supplier.invoicesSuffix", locale)} · {rands(pos.spent_cents)}
                      </p>
                      {/* Named in full as well as on the business name above: "open the
                          account" is the action, and a bare name does not look like one. */}
                      <Link
                        href={`/suppliers/${row.id}`}
                        className="focus-ring inline-flex min-h-[2.75rem] items-center rounded text-sm font-medium text-brand-700 underline-offset-2 hover:underline sm:min-h-0"
                      >
                        {t("supplier.openAccount", locale)}
                      </Link>
                    </div>
                  </div>

                  <details className="text-sm">
                    <summary className="focus-ring inline-flex min-h-[2.75rem] cursor-pointer items-center font-medium text-brand-700 sm:min-h-0">
                      {t("supplier.editOpen", locale)}
                    </summary>

                    <form action={updateSupplier} className="mt-2 flex flex-col gap-3">
                      <input type="hidden" name="supplier_id" value={row.id} />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <TextField
                          id={`name_${row.id}`}
                          name="name"
                          label={t("supplier.name", locale)}
                          defaultValue={row.name}
                          required
                        />
                        <TextField
                          id={`contact_${row.id}`}
                          name="contact_person"
                          label={t("supplier.contact", locale)}
                          defaultValue={row.contact_person ?? ""}
                        />
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <TextField id={`phone_${row.id}`} name="phone" type="tel" label={t("supplier.phone", locale)} defaultValue={row.phone ?? ""} />
                        <TextField id={`email_${row.id}`} name="email" type="email" label={t("supplier.email", locale)} defaultValue={row.email ?? ""} />
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <TextField id={`vat_${row.id}`} name="vat_number" label={t("supplier.vatNumber", locale)} defaultValue={row.vat_number ?? ""} />
                        <TextField id={`acc_${row.id}`} name="account_number" label={t("supplier.accountNumber", locale)} defaultValue={row.account_number ?? ""} />
                        <Field label={t("supplier.terms", locale)} htmlFor={`terms_${row.id}`}>
                          <Input
                            id={`terms_${row.id}`}
                            name="payment_terms_days"
                            inputMode="numeric"
                            defaultValue={row.payment_terms_days != null ? String(row.payment_terms_days) : ""}
                          />
                        </Field>
                      </div>
                      <TextField id={`addr_${row.id}`} name="address" label={t("supplier.address", locale)} defaultValue={row.address ?? ""} />
                      <TextareaField id={`notes_${row.id}`} name="notes" label={t("supplier.notes", locale)} rows={2} defaultValue={row.notes ?? ""} />
                      <SubmitButton variant="secondary" className="self-start">{t("common.save", locale)}</SubmitButton>
                    </form>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {/* Deactivating is reversible and touches no history, so it is a plain
                          submit; deleting is neither, so it is not. */}
                      <form action={setSupplierActive}>
                        <input type="hidden" name="supplier_id" value={row.id} />
                        <input type="hidden" name="active" value={row.active ? "0" : "1"} />
                        <SubmitButton variant="ghost" size="sm">
                          {row.active ? t("supplier.deactivate", locale) : t("supplier.reactivate", locale)}
                        </SubmitButton>
                      </form>

                      <ConfirmDialog
                        action={deleteSupplier}
                        triggerLabel={t("common.remove", locale)}
                        triggerIcon={<TrashIcon />}
                        triggerVariant="ghost"
                        triggerSize="sm"
                        triggerClassName="text-status-overdue hover:bg-red-50"
                        title={t("supplier.deleteTitle", locale)}
                        intro={row.name}
                        consequencesTitle={t("confirm.whatHappens", locale)}
                        consequences={[
                          t("supplier.deleteConsequence1", locale),
                          t("supplier.deleteConsequence2", locale),
                        ]}
                        footnote={t("supplier.deleteFootnote", locale)}
                        confirmLabel={t("common.remove", locale)}
                        cancelLabel={t("confirm.keepIt", locale)}
                        closeLabel={t("ui.close", locale)}
                      >
                        <input type="hidden" name="supplier_id" value={row.id} />
                      </ConfirmDialog>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {unfiledCount > 0 ? (
        <p className="text-sm text-sand-600">{t("supplier.unfiledNote", locale)}</p>
      ) : null}
    </div>
  );
}
