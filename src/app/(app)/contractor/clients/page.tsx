import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, homePathFor } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { shortDate } from "@/lib/format";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { GetStarted } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { TextField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { PlusIcon } from "@/components/ui/icons";
import { createClientRecord } from "./actions";

/**
 * The partner's own client book (F15).
 *
 * A mechanic's customer list exists before FleetWise does, and most of it is not on
 * FleetWise at all. Until now a partner could only see farms that had already found them
 * and connected — which is fine as a growth loop and useless as a management system. This
 * is the whole book: the farms they are connected to, and everybody else, in one list.
 *
 * A client here is the partner's own record and grants them nothing. Access to a farm
 * still comes only from an active link, which only that farm can approve.
 */

type ClientRow = {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  farm_id: string | null;
  link_status: string;
  requested_at: string | null;
  linked_at: string | null;
};

export default async function PartnerClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; removed?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.lang;
  const sp = await searchParams;

  const supabase = await createClient();
  const [{ data: cData }, { data: vData }, { data: linkData }] = await Promise.all([
    supabase
      .from("partner_clients")
      .select("id, name, contact_name, phone, whatsapp, email, farm_id, link_status, requested_at, linked_at")
      .is("deleted_at", null)
      .order("name"),
    supabase.from("partner_client_vehicles").select("client_id").is("deleted_at", null),
    // Farms already connected, so the book can show which of them are not yet in it.
    supabase.from("workshop_links").select("farm_id, status, farms(id, name)").is("deleted_at", null),
  ]);

  const clients = (cData ?? []) as ClientRow[];
  const vehicleCount = new Map<string, number>();
  for (const v of (vData ?? []) as { client_id: string }[]) {
    vehicleCount.set(v.client_id, (vehicleCount.get(v.client_id) ?? 0) + 1);
  }

  const links = ((linkData ?? []) as unknown as {
    farm_id: string;
    status: string;
    farms: { id: string; name: string } | { id: string; name: string }[] | null;
  }[]).map((l) => ({
    farm_id: l.farm_id,
    status: l.status,
    farm: Array.isArray(l.farms) ? (l.farms[0] ?? null) : l.farms,
  }));

  // A farm that connected through the directory, before this partner ever wrote it down.
  const booked = new Set(clients.map((c) => c.farm_id).filter(Boolean));
  const unbookedFarms = links.filter((l) => l.status === "active" && l.farm && !booked.has(l.farm_id));

  const linked = clients.filter((c) => c.farm_id);
  const waiting = clients.filter((c) => !c.farm_id && c.link_status === "requested");
  const offline = clients.filter((c) => !c.farm_id && c.link_status !== "requested");

  function Row({ c }: { c: ClientRow }) {
    const n = vehicleCount.get(c.id) ?? 0;
    return (
      <li className="flex flex-col gap-2 rounded-xl border border-sand-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/contractor/clients/${c.id}`} className="focus-ring rounded font-medium text-sand-900 hover:text-brand-700 hover:underline">
            {c.name}
          </Link>
          {c.farm_id ? (
            <Badge tone="ok">{t("clients.connected", locale)}</Badge>
          ) : c.link_status === "requested" ? (
            <Badge tone="info">{t("clients.asked", locale)}</Badge>
          ) : c.link_status === "declined" ? (
            <Badge tone="warning">{t("clients.declined", locale)}</Badge>
          ) : null}
          <span className="ml-auto text-sm text-sand-500">
            {n > 0 ? t("clients.nVehicles", locale).replace("{n}", String(n)) : t("clients.noVehicles", locale)}
          </span>
        </div>
        <p className="text-sm text-sand-600">
          {[c.contact_name, c.phone ?? c.whatsapp, c.email].filter(Boolean).join(" · ") || t("clients.noContact", locale)}
        </p>
        <div className="flex flex-wrap gap-2">
          {c.phone ? (
            <a href={telHref(c.phone) ?? "#"} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {t("contact.call", locale)}
            </a>
          ) : null}
          {c.whatsapp ? (
            <a href={waHref(c.whatsapp) ?? "#"} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {t("contact.whatsapp", locale)}
            </a>
          ) : null}
          {c.email ? (
            <a href={mailtoHref(c.email) ?? "#"} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {t("contact.email", locale)}
            </a>
          ) : null}
          {c.linked_at ? (
            <span className="self-center text-xs text-sand-400">
              {t("clients.connectedOn", locale)} {shortDate(c.linked_at, locale)}
            </span>
          ) : null}
        </div>
      </li>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("clients.title", locale)}</h1>
        <PageInfoButton infoKey="clients" locale={locale} />
      </div>
      <p className="text-sand-600">{t("clients.lead", locale)}</p>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.removed ? t("clients.removed", locale) : undefined} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("clients.total", locale)} value={clients.length} />
        <Stat label={t("clients.connectedCount", locale)} value={linked.length} tone="ok" />
        <Stat label={t("clients.waitingCount", locale)} value={waiting.length} />
        <Stat label={t("clients.offlineCount", locale)} value={offline.length} />
      </div>

      {/* Farms that connected through the directory but were never written down. Offering
          to add them keeps one list rather than two half-lists. */}
      {unbookedFarms.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("clients.alreadyConnected", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-600">{t("clients.alreadyConnectedHint", locale)}</p>
          <ul className="flex flex-col gap-2">
            {unbookedFarms.map((l) => (
              <li key={l.farm_id} className="flex flex-wrap items-center gap-2 rounded-lg border border-sand-200 px-3 py-2">
                <span className="font-medium text-sand-900">{l.farm?.name}</span>
                <Badge tone="ok">{t("clients.connected", locale)}</Badge>
                <form action={createClientRecord} className="ml-auto">
                  <input type="hidden" name="name" value={l.farm?.name ?? ""} />
                  {/* The farm id, so the new record is created CONNECTED rather than
                      filed under "everyone else". The action re-checks it against a live
                      active link before trusting it. */}
                  <input type="hidden" name="farm_id" value={l.farm_id} />
                  <SubmitButton variant="secondary" size="sm">{t("clients.addToBook", locale)}</SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {clients.length === 0 ? (
        <GetStarted title={t("clients.emptyTitle", locale)} hint={t("clients.emptyBody", locale)} />
      ) : (
        <div className="flex flex-col gap-4">
          {linked.length > 0 ? (
            <Card>
              <CardHeader><CardTitle>{t("clients.onFleetWise", locale)}</CardTitle></CardHeader>
              <ul className="flex flex-col gap-2">{linked.map((c) => <Row key={c.id} c={c} />)}</ul>
            </Card>
          ) : null}
          {waiting.length > 0 ? (
            <Card>
              <CardHeader><CardTitle>{t("clients.waitingTitle", locale)}</CardTitle></CardHeader>
              <p className="mb-2 text-sm text-sand-500">{t("clients.waitingHint", locale)}</p>
              <ul className="flex flex-col gap-2">{waiting.map((c) => <Row key={c.id} c={c} />)}</ul>
            </Card>
          ) : null}
          {offline.length > 0 ? (
            <Card>
              <CardHeader><CardTitle>{t("clients.everyoneElse", locale)}</CardTitle></CardHeader>
              <ul className="flex flex-col gap-2">{offline.map((c) => <Row key={c.id} c={c} />)}</ul>
            </Card>
          ) : null}
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>{t("clients.addTitle", locale)}</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-sand-600">{t("clients.addHint", locale)}</p>
        <form action={createClientRecord} className="flex flex-col gap-3">
          <TextField name="name" label={t("clients.name", locale)} required />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="contact_name" label={t("clients.contactName", locale)} />
            <TextField name="phone" type="tel" label={t("clients.phone", locale)} />
            <TextField name="whatsapp" type="tel" label={t("clients.whatsapp", locale)} />
            <TextField
              name="email"
              type="email"
              label={t("clients.email", locale)}
              hint={t("clients.emailHint", locale)}
            />
          </div>
          <TextareaField name="address" rows={2} label={t("clients.address", locale)} />
          <TextareaField name="notes" rows={2} label={t("clients.notes", locale)} />
          <SubmitButton leftIcon={<PlusIcon />}>{t("clients.add", locale)}</SubmitButton>
        </form>
      </Card>
    </div>
  );
}
