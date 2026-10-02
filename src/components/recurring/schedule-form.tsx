"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { CADENCES, advanceByCadence, type Cadence } from "@/lib/recurring";
import { shortDate, todayLocal } from "@/lib/format";
import { TextField, SelectField, TextareaField } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogActions, DialogFields, DialogForm, DialogSection } from "@/components/ui/dialog-form";
import { PlusIcon } from "@/components/ui/icons";
import { createSchedule } from "@/app/(app)/recurring/actions";

type Party = { key: string; label: string; farm_id: string | null; client_id: string | null };

/**
 * Setting up a standing invoice, behind one button.
 *
 * It was a card of twelve controls between "due to go out" and the list, so the page
 * opened on a blank form rather than on the schedules. Now the page shows what is set
 * up, and this asks for what is new.
 *
 * Two things are shown live because both are easy to get wrong and impossible to see in a
 * static form: WHO it will bill (the recipient control switches between a farm you are
 * linked to, a customer from your own book, and a name typed here), and WHEN the one
 * after next falls. That second one matters more than it looks, a schedule started on
 * the 31st bills on the 28th in February and 31st again in March, and seeing the next two
 * dates before saving is what stops a partner assuming it drifted.
 *
 * The posted field names are unchanged; `createSchedule` reads exactly what it did.
 */
export function ScheduleForm({
  locale,
  parties,
  defaultVatBps,
  triggerVariant = "primary",
}: {
  locale: Lang;
  parties: Party[];
  defaultVatBps: number;
  triggerVariant?: "primary" | "secondary";
}) {
  const [kind, setKind] = useState<"farm" | "client" | "oneoff">(parties.length > 0 ? "farm" : "oneoff");
  const [party, setParty] = useState(parties[0]?.key ?? "");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  // Today in South Africa, so a partner setting this up after 22:00 is not offered tomorrow.
  const [start, setStart] = useState(() => todayLocal());

  const chosen = parties.find((p) => p.key === party);
  const farms = parties.filter((p) => p.farm_id);
  const clients = parties.filter((p) => p.client_id);
  const options = kind === "farm" ? farms : clients;

  const then = /^\d{4}-\d{2}-\d{2}$/.test(start) ? advanceByCadence(start, cadence) : "";
  const after = then ? advanceByCadence(then, cadence) : "";

  return (
    <DialogForm
      trigger={t("recurring.addTitle", locale)}
      triggerIcon={<PlusIcon />}
      triggerVariant={triggerVariant}
      title={t("recurring.addTitle", locale)}
      description={t("recurring.lead", locale)}
      closeLabel={t("ui.close", locale)}
    >
      <form action={createSchedule}>
        <input type="hidden" name="recipient_kind" value={kind} />
        {kind === "farm" ? <input type="hidden" name="farm_id" value={chosen?.farm_id ?? ""} /> : null}
        {kind === "client" ? <input type="hidden" name="partner_client_id" value={chosen?.client_id ?? ""} /> : null}
        <input type="hidden" name="vat_percent" value={String(defaultVatBps / 100)} />

        <DialogFields>
          <div className="sm:col-span-2">
            <TextField name="name" label={t("recurring.name", locale)} hint={t("recurring.nameHint", locale)} required />
          </div>

          <SelectField
            name="recipient_kind_visible"
            label={t("recurring.who", locale)}
            value={kind}
            onChange={(e) => {
              const next = e.target.value as "farm" | "client" | "oneoff";
              setKind(next);
              const first = next === "farm" ? farms[0] : next === "client" ? clients[0] : undefined;
              setParty(first?.key ?? "");
            }}
          >
            <option value="farm" disabled={farms.length === 0}>{t("recurring.whoFarm", locale)}</option>
            <option value="client" disabled={clients.length === 0}>{t("recurring.whoClient", locale)}</option>
            <option value="oneoff">{t("recurring.whoTyped", locale)}</option>
          </SelectField>

          {kind === "oneoff" ? (
            <TextField name="bill_to_name" label={t("recurring.billToName", locale)} required />
          ) : (
            <SelectField
              name="party_visible"
              label={t("recurring.whichCustomer", locale)}
              value={party}
              onChange={(e) => setParty(e.target.value)}
            >
              {options.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </SelectField>
          )}

          <SelectField
            name="cadence"
            label={t("recurring.howOften", locale)}
            value={cadence}
            onChange={(e) => setCadence(e.target.value as Cadence)}
          >
            {CADENCES.map((c) => (
              <option key={c} value={c}>{t(`cadence.${c}`, locale)}</option>
            ))}
          </SelectField>
          <TextField
            name="next_issue_date"
            type="date"
            label={t("recurring.firstOn", locale)}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />

          {then ? (
            <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-700 sm:col-span-2">
              {t("recurring.thenPreview", locale)}{" "}
              <span className="font-medium text-sand-900">{shortDate(then, locale)}</span>,{" "}
              <span className="font-medium text-sand-900">{shortDate(after, locale)}</span>…
            </p>
          ) : null}

          {/* The first line, here rather than on a second screen. A schedule with no lines
              raises nothing, and a partner who has to go somewhere else to add one may not. */}
          <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border border-sand-200 p-3 sm:col-span-2">
            <legend className="px-1 text-sm font-medium text-sand-900">{t("recurring.whatToBill", locale)}</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField name="description" label={t("recurring.lineDescription", locale)} className="sm:col-span-2" />
              <TextField name="unit_price" inputMode="decimal" label={t("recurring.linePrice", locale)} />
            </div>
            <Checkbox name="incl_vat" defaultChecked label={t("recurring.priceInclVat", locale)} />
          </fieldset>

          {/* What most schedules never need on day one: their own invoice wording, an end
              date, a note, and sending without a look first. */}
          <DialogSection title={t("recurring.moreOptions", locale)}>
            <div className="sm:col-span-2">
              <TextField name="subject" label={t("recurring.subject", locale)} hint={t("recurring.subjectHint", locale)} />
            </div>
            <TextField name="ends_on" type="date" label={t("recurring.endsOn", locale)} hint={t("recurring.endsOnHint", locale)} />
            <div className="sm:col-span-2">
              <TextareaField name="notes" rows={2} label={t("recurring.notes", locale)} />
            </div>
            <div className="sm:col-span-2">
              <Checkbox name="auto_send" label={t("recurring.autoSend", locale)} hint={t("recurring.autoSendHint", locale)} />
            </div>
          </DialogSection>
        </DialogFields>

        <DialogActions cancelLabel={t("common.cancel", locale)}>
          <SubmitButton>{t("recurring.save", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );
}
