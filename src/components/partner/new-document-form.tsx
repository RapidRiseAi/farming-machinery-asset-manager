"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { SelectField, TextField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { PlusIcon } from "@/components/ui/icons";

export type Recipient = { id: string; name: string };

type Kind = "farm" | "client" | "oneoff";

/**
 * Start a document, for whichever of the three kinds of customer this is.
 *
 * The recipient choice drives the form: pick a farm or a saved client and there is
 * nothing else to type, because the billing details are seeded from their record by the
 * 0410 trigger. Pick a one-time customer and the details appear, because there is no
 * record to seed from — that is the whole difference and it is why the fields are not all
 * on screen at once.
 *
 * The billing block is available on the saved kinds too, behind a disclosure, because
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
  const [showBilling, setShowBilling] = useState(false);
  const oneoff = kind === "oneoff";

  return (
    <details className="ml-auto">
      <summary className="focus-ring inline-flex min-h-[48px] cursor-pointer list-none items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 sm:min-h-[40px] [&::-webkit-details-marker]:hidden">
        <PlusIcon /> {t("doc.new", locale)}
      </summary>

      <form
        action={action}
        className="mt-3 flex w-full max-w-lg flex-col gap-3 rounded-xl border border-sand-200 bg-white p-4 shadow-soft"
      >
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

        {/* For a one-time customer these are the record. For a saved one they are an
            override of it, so they stay behind a disclosure. */}
        {oneoff || showBilling ? (
          <div className="flex flex-col gap-3 rounded-lg border border-sand-200 bg-sand-50 p-3">
            <TextField
              name="bill_to_name"
              label={t("doc.billToName", locale)}
              required={oneoff}
              autoComplete="organization"
            />
            <TextField name="bill_to_contact" label={t("doc.billToContact", locale)} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField name="bill_to_email" label={t("doc.billToEmail", locale)} type="email" />
              <TextField name="bill_to_phone" label={t("doc.billToPhone", locale)} type="tel" />
            </div>
            <TextareaField
              name="bill_to_address"
              label={t("doc.billToAddress", locale)}
              hint={t("doc.billToAddressHint", locale)}
              rows={2}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField
                name="bill_to_vat_number"
                label={t("doc.billToVat", locale)}
                hint={t("doc.billToVatHint", locale)}
              />
              <TextField name="bill_to_reg_number" label={t("doc.billToReg", locale)} />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowBilling(true)}
            className="focus-ring self-start rounded text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            {t("doc.changeBilling", locale)}
          </button>
        )}

        <TextField name="subject" label={t("doc.newSubject", locale)} hint={t("doc.newSubjectHint", locale)} />
        <TextField
          name="bill_to_reference"
          label={t("doc.theirReference", locale)}
          hint={t("doc.theirReferenceHint", locale)}
        />

        <SubmitButton>{t("doc.newCreate", locale)}</SubmitButton>
      </form>
    </details>
  );
}
