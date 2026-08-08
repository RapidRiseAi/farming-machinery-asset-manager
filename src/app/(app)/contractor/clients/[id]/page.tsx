import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireProfile, homePathFor } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { shortDate } from "@/lib/format";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { Button, buttonVariants } from "@/components/ui/button";
import { TextField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon, PlusIcon } from "@/components/ui/icons";
import {
  updateClientRecord, removeClientRecord, addClientVehicle,
  removeClientVehicle, requestClientLink, syncClientVehicles,
} from "../actions";

/**
 * One client in the partner's book (F15).
 *
 * Three states, and the screen says plainly which one you are in:
 *   * not on FleetWise — the partner keeps their own notes and vehicle list here;
 *   * asked — a request is with the customer, and only the customer can accept it;
 *   * connected — the farm's real fleet is now reachable, and the notebook vehicles can
 *     be copied across in one action.
 */

type ClientRow = {
  id: string; name: string; contact_name: string | null;
  phone: string | null; whatsapp: string | null; email: string | null;
  address: string | null; notes: string | null;
  trading_name: string | null; reg_number: string | null; vat_number: string | null;
  payment_terms_days: number | null; credit_limit_cents: number | null;
  farm_id: string | null; link_status: string;
  requested_at: string | null; linked_at: string | null; synced_at: string | null;
};

type Vehicle = {
  id: string; name: string; make: string | null; model: string | null;
  reg_no: string | null; serial_no: string | null; year: number | null;
  notes: string | null; machine_id: string | null;
};

export default async function PartnerClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.lang;
  const { id } = await params;
  const sp = await searchParams;

  const supabase = await createClient();
  const { data } = await supabase
    .from("partner_clients")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const client = data as ClientRow | null;
  if (!client) notFound();

  const [{ data: vData }, { data: farmData }] = await Promise.all([
    supabase
      .from("partner_client_vehicles")
      .select("id, name, make, model, reg_no, serial_no, year, notes, machine_id")
      .eq("client_id", id)
      .is("deleted_at", null)
      .order("name"),
    client.farm_id
      ? supabase.from("farms").select("id, name").eq("id", client.farm_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const vehicles = (vData ?? []) as Vehicle[];
  const farm = farmData as { id: string; name: string } | null;
  const toCopy = vehicles.filter((v) => !v.machine_id).length;
  const connected = !!client.farm_id;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/contractor/clients" className="focus-ring rounded text-sm text-brand-700 hover:underline">
          ← {t("clients.title", locale)}
        </Link>
        {connected ? <Badge tone="ok" className="ml-auto">{t("clients.connected", locale)}</Badge> : null}
      </div>

      <h1 className="text-2xl font-bold tracking-tight text-sand-900">{client.name}</h1>

      <Flash tone="error" message={sp.error === "already-synced" ? t("clients.alreadySynced", locale) : sp.error} />
      <Flash tone="success" message={sp.saved || sp.added ? t("ui.saved", locale) : undefined} />
      <Flash tone="success" message={sp.asked ? t("clients.askedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.connected ? t("clients.connectedFlash", locale) : undefined} />
      {/* A partial copy is a warning, not a success: the offer stays open and the rest
          are still waiting, so saying "done" would be a lie. */}
      <Flash
        tone={sp.failed ? "warning" : "success"}
        message={
          sp.synced
            ? (sp.failed ? t("clients.syncPartial", locale) : t("clients.syncedFlash", locale)).replace("{n}", sp.synced)
            : undefined
        }
      />

      {/* ── Where this client stands ─────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>{t("clients.statusTitle", locale)}</CardTitle></CardHeader>
        {connected ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-sand-700">
              {t("clients.connectedBody", locale)} <span className="font-medium">{farm?.name}</span>
              {client.linked_at ? ` · ${shortDate(client.linked_at, locale)}` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href="/machines" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                {t("clients.seeFleet", locale)}
              </Link>
              <Link href="/work" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                {t("nav.work", locale)}
              </Link>
              <Link href="/documents" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                {t("nav.documents", locale)}
              </Link>
            </div>

            {toCopy > 0 && !client.synced_at ? (
              <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-3">
                <p className="text-sm font-medium text-sand-900">{t("clients.syncTitle", locale)}</p>
                <p className="mb-3 mt-1 text-sm text-sand-600">
                  {t("clients.syncBody", locale).replace("{n}", String(toCopy))}
                </p>
                <ConfirmDialog
                  action={syncClientVehicles}
                  triggerLabel={t("clients.syncAction", locale)}
                  triggerVariant="primary"
                  triggerSize="sm"
                  title={t("clients.syncConfirmTitle", locale)}
                  intro={t("clients.syncConfirmBody", locale).replace("{n}", String(toCopy)).replace("{farm}", farm?.name ?? "")}
                  consequences={[t("clients.syncConsequence", locale)]}
                  confirmLabel={t("clients.syncAction", locale)}
                  cancelLabel={t("common.cancel", locale)}
                  closeLabel={t("ui.close", locale)}
                  tone="brand"
                >
                  <input type="hidden" name="client_id" value={client.id} />
                </ConfirmDialog>
              </div>
            ) : client.synced_at ? (
              <p className="text-sm text-sand-500">
                {t("clients.syncedAlready", locale)} {shortDate(client.synced_at, locale)}
              </p>
            ) : null}
          </div>
        ) : client.link_status === "requested" ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-sand-700">{t("clients.askedBody", locale)}</p>
            {client.requested_at ? (
              <p className="text-sm text-sand-500">
                {t("clients.askedOn", locale)} {shortDate(client.requested_at, locale)}
              </p>
            ) : null}
            <p className="text-sm text-sand-500">{t("clients.askedShare", locale)}</p>
            <div className="flex flex-wrap gap-2">
              {client.whatsapp ? (
                <a
                  href={waHref(client.whatsapp, t("clients.inviteMessage", locale)) ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: "secondary", size: "sm" })}
                >
                  {t("clients.shareWhatsapp", locale)}
                </a>
              ) : null}
              {client.email ? (
                <a href={mailtoHref(client.email, t("clients.inviteSubject", locale), t("clients.inviteMessage", locale)) ?? "#"} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  {t("clients.shareEmail", locale)}
                </a>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-sand-700">{t("clients.notConnectedBody", locale)}</p>
            {client.email ? (
              <form action={requestClientLink}>
                <input type="hidden" name="client_id" value={client.id} />
                <SubmitButton size="sm">{t("clients.askToConnect", locale)}</SubmitButton>
              </form>
            ) : (
              <p className="text-sm text-sand-500">{t("clients.needEmail", locale)}</p>
            )}
          </div>
        )}
      </Card>

      {/* ── Contact ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>{t("clients.contactTitle", locale)}</CardTitle></CardHeader>
        <div className="mb-3 flex flex-wrap gap-2">
          {client.phone ? (
            <a href={telHref(client.phone) ?? "#"} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {t("contact.call", locale)}
            </a>
          ) : null}
          {client.whatsapp ? (
            <a href={waHref(client.whatsapp) ?? "#"} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {t("contact.whatsapp", locale)}
            </a>
          ) : null}
          {client.email ? (
            <a href={mailtoHref(client.email) ?? "#"} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {t("contact.email", locale)}
            </a>
          ) : null}
        </div>
        <form action={updateClientRecord} className="flex flex-col gap-3">
          <input type="hidden" name="client_id" value={client.id} />
          <TextField name="name" label={t("clients.name", locale)} defaultValue={client.name} required />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="contact_name" label={t("clients.contactName", locale)} defaultValue={client.contact_name ?? ""} />
            <TextField name="phone" type="tel" label={t("clients.phone", locale)} defaultValue={client.phone ?? ""} />
            <TextField name="whatsapp" type="tel" label={t("clients.whatsapp", locale)} defaultValue={client.whatsapp ?? ""} />
            <TextField name="email" type="email" label={t("clients.email", locale)} defaultValue={client.email ?? ""} />
          </div>
          <TextareaField name="address" rows={2} label={t("clients.address", locale)} defaultValue={client.address ?? ""} />

          {/* Billing identity (0410). Held on the client so it is not retyped — and so it
              is right on the invoice, where a missing VAT number costs them the claim. */}
          <fieldset className="flex flex-col gap-3 rounded-lg border border-sand-200 bg-sand-50 p-3">
            <legend className="px-1 text-sm font-semibold text-sand-900">{t("clients.billing", locale)}</legend>
            <p className="-mt-1 text-sm text-sand-600">{t("clients.billingHint", locale)}</p>
            <TextField name="trading_name" label={t("clients.tradingName", locale)} defaultValue={client.trading_name ?? ""} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField
                name="vat_number"
                label={t("clients.vatNo", locale)}
                hint={t("clients.vatNoHint", locale)}
                defaultValue={client.vat_number ?? ""}
              />
              <TextField name="reg_number" label={t("clients.regNo", locale)} defaultValue={client.reg_number ?? ""} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField
                name="payment_terms_days"
                type="number"
                min={0}
                max={365}
                label={t("clients.terms", locale)}
                hint={t("clients.termsHint", locale)}
                defaultValue={client.payment_terms_days != null ? String(client.payment_terms_days) : ""}
              />
              <TextField
                name="credit_limit"
                label={t("clients.creditLimit", locale)}
                hint={t("clients.creditLimitHint", locale)}
                defaultValue={client.credit_limit_cents != null ? (client.credit_limit_cents / 100).toFixed(2) : ""}
              />
            </div>
          </fieldset>

          <TextareaField name="notes" rows={3} label={t("clients.notes", locale)} defaultValue={client.notes ?? ""} />
          <SubmitButton variant="secondary">{t("common.save", locale)}</SubmitButton>
        </form>
      </Card>

      {/* ── Their vehicles ───────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>{t("clients.vehiclesTitle", locale)}</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-sand-600">
          {connected ? t("clients.vehiclesConnectedHint", locale) : t("clients.vehiclesHint", locale)}
        </p>

        {vehicles.length > 0 ? (
          <ul className="mb-4 flex flex-col gap-2">
            {vehicles.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-sand-200 px-3 py-2">
                <span className="font-medium text-sand-900">{v.name}</span>
                <span className="text-sm text-sand-600">
                  {[v.make, v.model, v.year ? String(v.year) : null, v.reg_no].filter(Boolean).join(" · ")}
                </span>
                {v.machine_id ? (
                  <Badge tone="ok">{t("clients.inFleet", locale)}</Badge>
                ) : null}
                <span className="ml-auto">
                  <ConfirmDialog
                    action={removeClientVehicle}
                    triggerLabel={t("common.remove", locale)}
                    triggerIcon={<TrashIcon />}
                    triggerVariant="ghost"
                    triggerSize="sm"
                    title={t("clients.removeVehicle", locale)}
                    intro={v.name}
                    confirmLabel={t("common.remove", locale)}
                    cancelLabel={t("common.cancel", locale)}
                    closeLabel={t("ui.close", locale)}
                  >
                    <input type="hidden" name="client_id" value={client.id} />
                    <input type="hidden" name="vehicle_id" value={v.id} />
                  </ConfirmDialog>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-4 text-sm text-sand-500">{t("clients.noVehiclesYet", locale)}</p>
        )}

        <form action={addClientVehicle} className="flex flex-col gap-3">
          <input type="hidden" name="client_id" value={client.id} />
          <TextField name="name" label={t("clients.vehicleName", locale)} hint={t("clients.vehicleNameHint", locale)} required />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="make" label={t("clients.make", locale)} />
            <TextField name="model" label={t("clients.model", locale)} />
            <TextField name="reg_no" label={t("clients.regNo", locale)} />
            <TextField name="year" type="number" min={1900} max={2200} label={t("clients.year", locale)} />
            <TextField name="serial_no" label={t("clients.serialNo", locale)} fieldClassName="sm:col-span-2" />
          </div>
          <TextareaField name="notes" rows={2} label={t("clients.notes", locale)} />
          <SubmitButton variant="secondary" leftIcon={<PlusIcon />}>{t("clients.addVehicle", locale)}</SubmitButton>
        </form>
      </Card>

      <div>
        <ConfirmDialog
          action={removeClientRecord}
          triggerLabel={t("clients.removeClient", locale)}
          triggerIcon={<TrashIcon />}
          triggerVariant="ghost"
          triggerSize="sm"
          title={t("clients.removeClientTitle", locale)}
          intro={client.name}
          consequences={[t("clients.removeClientConsequence", locale)]}
          footnote={connected ? t("clients.removeClientKeepsLink", locale) : undefined}
          confirmLabel={t("clients.removeClient", locale)}
          cancelLabel={t("common.cancel", locale)}
          closeLabel={t("ui.close", locale)}
        >
          <input type="hidden" name="client_id" value={client.id} />
        </ConfirmDialog>
      </div>
    </div>
  );
}
