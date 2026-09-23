"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { SelectField, TextField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { PlusIcon } from "@/components/ui/icons";
import { DialogActions, DialogFields, DialogForm, DialogSection } from "@/components/ui/dialog-form";

export type Recipient = { id: string; name: string };

type Kind = "farm" | "client" | "oneoff";

/**
 * Start a document, for whichever of the three kinds of customer this is.
 *
 * The recipient choice drives the form: pick a farm or a saved client and there is
 * nothing else to type, because the billing details are seeded from their record by the
 * 0410 trigger. Pick a one-time customer and the details appear, because there is no
 * record to seed from, that is the whole difference and it is why the fields are not all
 * on screen at once.
 *
 * The billing block is available on the saved kinds too, as a collapsed section, because
 * "their VAT number changed" happens and the document that goes out today should carry
 * today's details without anyone having to go and edit the customer record first.
 */
export function NewDocumentForm({
  action,
  farms,
  clients,
  locale,
}: {
  action: (formData: FormData) => void | Promise<void>;
  farms: Recipient[];
  clients: Recipient[];
  locale: Lang;
}) {
  const available: Kind[] = [
    ...(farms.length > 0 ? (["farm"] as const) : []),
    ...(clients.length > 0 ? (["client"] as const) : []),
    "oneoff",
  ];
  const [kind, setKind] = useState<Kind>(available[0]);
  const oneoff = kind === "oneoff";

  /*
    Was a `<details>` whose `<summary>` hand-rolled the primary button in raw classes
    (`bg-brand-600 text-white hover:bg-brand-700`), a copy of `buttonVariants` that could
    not follow it, opening a panel with no focus trap and no Escape. The `kind` state
    stays HERE, above the dialog, so switching customer type and closing by accident does
    not lose the choice.
  */
  return (
    <div className="ml-auto flex">
      <DialogForm
        trigger={t("doc.new", locale)}
        triggerIcon={<PlusIcon />}
        title={t("doc.new", locale)}
        closeLabel={t("ui.close", locale)}
        size="md"
      >
        <form action={action}>
          <DialogFields columns={1}>
            <SelectField name="kind" label={t("doc.newKind", locale)} defaultValue="quote">
              <option value="quote">{t("doc.kindQuote", locale)}</option>
              <option value="invoice">{t("doc.kindInvoice", locale)}</option>
            </SelectField>

            <SelectField
              name="recipient_kind"
              label={t("doc.whoFor", locale)}
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              {available.includes("farm") ? <option value="farm">{t("doc.whoFarm", locale)}</option> : null}
              {available.includes("client") ? <option value="client">{t("doc.whoClient", locale)}</option> : null}
              <option value="oneoff">{t("doc.whoOneOff", locale)}</option>
            </SelectField>

            {kind === "farm" ? (
              <SelectField name="farm_id" label={t("doc.newCustomer", locale)} required>
                {farms.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </SelectField>
            ) : null}

            {kind === "client" ? (
              <SelectField name="partner_client_id" label={t("doc.newCustomer", locale)} required>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </SelectField>
            ) : null}

            {oneoff ? (
              <p className="-mt-1 text-sm text-sand-600">{t("doc.oneOffHint", locale)}</p>
            ) : null}

            <TextField name="subject" label={t("doc.newSubject", locale)} hint={t("doc.newSubjectHint", locale)} />
            <TextField
              name="bill_to_reference"
              label={t("doc.theirReference", locale)}
              hint={t("doc.theirReferenceHint", locale)}
            />

            {/*
              For a one-time customer these ARE the record, so the section opens itself.
              For a saved one they are an override of what the 0410 trigger will seed, so
              it stays shut until somebody says "their VAT number changed".

              It used to be a bespoke "Change billing details" text button that swapped
              itself for the fields and could not be closed again. A `DialogSection` is
              the same idea, reversible, and identical to every other optional group in
              the product.
            */}
            <DialogSection title={t("doc.changeBilling", locale)} defaultOpen={oneoff}>
              <div className="sm:col-span-2">
                <TextField
                  name="bill_to_name"
                  label={t("doc.billToName", locale)}
                  required={oneoff}
                  autoComplete="organization"
                />
              </div>
              <div className="sm:col-span-2">
                <TextField name="bill_to_contact" label={t("doc.billToContact", locale)} />
              </div>
              <TextField name="bill_to_email" label={t("doc.billToEmail", locale)} type="email" />
              <TextField name="bill_to_phone" label={t("doc.billToPhone", locale)} type="tel" />
              <div className="sm:col-span-2">
                <TextareaField
                  name="bill_to_address"
                  label={t("doc.billToAddress", locale)}
                  hint={t("doc.billToAddressHint", locale)}
                  rows={2}
                />
              </div>
              <TextField
                name="bill_to_vat_number"
                label={t("doc.billToVat", locale)}
                hint={t("doc.billToVatHint", locale)}
              />
              <TextField name="bill_to_reg_number" label={t("doc.billToReg", locale)} />
            </DialogSection>
          </DialogFields>

          <DialogActions cancelLabel={t("common.cancel", locale)}>
            <SubmitButton variant="primary">{t("doc.newCreate", locale)}</SubmitButton>
          </DialogActions>
        </form>
      </DialogForm>
    </div>
  );
}
