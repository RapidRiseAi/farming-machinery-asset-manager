"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { CADENCES, advanceByCadence, type Cadence } from "@/lib/recurring";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField, SelectField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { createSchedule } from "@/app/(app)/recurring/actions";

type Party = { key: string; label: string; farm_id: string | null; client_id: string | null };

/**
 * Setting up a standing invoice.
 *
 * Two things are shown live because both are easy to get wrong and impossible to see in a
 * static form: WHO it will bill (the recipient control switches between a farm you are
 * linked to, a customer from your own book, and a name typed here), and WHEN the one
 * after next falls. That second one matters more than it looks — a schedule started on
 * the 31st bills on the 28th in February and 31st again in March, and seeing the next two
 * dates before saving is what stops a partner assuming it drifted.
 */
export function ScheduleForm({
  locale,
  parties,
  defaultVatBps,
}: {
  locale: Lang;
  parties: Party[];
  defaultVatBps: number;
}) {
  const [kind, setKind] = useState<"farm" | "client" | "oneoff">(parties.length > 0 ? "farm" : "oneoff");
  const [party, setParty] = useState(parties[0]?.key ?? "");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));

  const chosen = parties.find((p) => p.key === party);
  const farms = parties.filter((p) => p.farm_id);
  const clients = parties.filter((p) => p.client_id);
  const options = kind === "farm" ? farms : clients;

  const then = /^\d{4}-\d{2}-\d{2}$/.test(start) ? advanceByCadence(start, cadence) : "";
  const after = then ? advanceByCadence(then, cadence) : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("recurring.addTitle", locale)}</CardTitle>
      </CardHeader>

      <form action={createSchedule} className="flex flex-col gap-3">
        <input type="hidden" name="recipient_kind" value={kind} />
        {kind === "farm" ? <input type="hidden" name="farm_id" value={chosen?.farm_id ?? ""} /> : null}
        {kind === "client" ? <input type="hidden" name="partner_client_id" value={chosen?.client_id ?? ""} /> : null}

        <TextField name="name" label={t("recurring.name", locale)} hint={t("recurring.nameHint", locale)} required />

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

        <TextField name="subject" label={t("recurring.subject", locale)} hint={t("recurring.subjectHint", locale)} />

        <div className="grid gap-3 sm:grid-cols-3">
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
          <TextField name="ends_on" type="date" label={t("recurring.endsOn", locale)} hint={t("recurring.endsOnHint", locale)} />
        </div>

        {then ? (
          <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-700">
            {t("recurring.thenPreview", locale)} <span className="font-medium text-sand-900">{then}</span>,{" "}
            <span className="font-medium text-sand-900">{after}</span>…
          </p>
        ) : null}

        {/* The first line, here rather than on a second screen. A schedule with no lines
            raises nothing, and a partner who has to go somewhere else to add one may not. */}
        <div className="rounded-lg border border-sand-200 p-3">
          <p className="mb-2 text-sm font-medium text-sand-900">{t("recurring.whatToBill", locale)}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField name="description" label={t("recurring.lineDescription", locale)} className="sm:col-span-2" />
            <TextField name="unit_price" inputMode="decimal" label={t("recurring.linePrice", locale)} />
          </div>
          <label className="mt-3 flex items-center gap-3 text-sm text-sand-700">
            <input type="checkbox" name="incl_vat" defaultChecked className="h-5 w-5 rounded border-sand-300 text-brand-600" />
            {t("recurring.priceInclVat", locale)}
          </label>
          <input type="hidden" name="vat_percent" value={String(defaultVatBps / 100)} />
        </div>

        <TextareaField name="notes" rows={2} label={t("recurring.notes", locale)} />

        <label className="flex items-start gap-3 text-sm text-sand-700">
          <input type="checkbox" name="auto_send" className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600" />
          <span>
            {t("recurring.autoSend", locale)}
            <span className="block text-xs text-sand-500">{t("recurring.autoSendHint", locale)}</span>
          </span>
        </label>

        <SubmitButton className="self-start">{t("recurring.save", locale)}</SubmitButton>
      </form>
    </Card>
  );
}
