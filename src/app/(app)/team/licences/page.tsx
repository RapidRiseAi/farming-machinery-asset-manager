import Link from "next/link";
import { redirect } from "next/navigation";

import { homePathFor, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { farmPermissionState } from "@/lib/permissions";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { enumLabel, shortDate } from "@/lib/format";
import {
  CREDENTIAL_TYPES,
  countTone,
  credentialLook,
  credentialPerson,
  credentialState,
  expiryOrder,
  type CredentialRow,
} from "@/lib/driver-credentials";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { GetStarted } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { ChevronDownIcon, TrashIcon } from "@/components/ui/icons";

import { addDriverCredential, removeDriverCredential, renewDriverCredential } from "./actions";

export const dynamic = "force-dynamic";

/**
 * What each person on the farm is licensed to do, and until when.
 *
 * == WHY IT IS A SEPARATE PAGE FROM /team =====================================
 * `/team` is about access to this product, who may sign in and what they may press. This
 * is about somebody's documents, and the two answer different questions on different days.
 * A farm opens this one when a truck is being loaded or an AARTO notice has arrived.
 *
 * == WHY THE LIST IS SORTED BY TROUBLE ========================================
 * Expired first, then expiring, then the rest, not alphabetically by name. The whole
 * value of this screen is the two rows at the top, and a list sorted by name buries them
 * among the fifteen people whose papers are fine.
 *
 * == WHAT IS NOT HERE =========================================================
 * A scanned copy of the card. Storing images of identity documents raises a POPIA
 * retention and access question this feature does not need to answer to be useful: the
 * dates are what expire, and the dates are what nobody is watching. Photographs can come
 * later, deliberately, with somewhere to say who may look at them.
 */
export default async function DriverLicencesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; renew?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role === "rr_admin") redirect("/admin/farms");
  const locale = profile.lang;
  const sp = await searchParams;

  const permissionState = await farmPermissionState(profile);
  const farmId = permissionState.farmId;
  const canManage = permissionState.role === "owner" || permissionState.role === "manager";
  // The same gate `/team` uses. RLS refuses the rows as well, a driver who types this URL
  // gets their own file and nothing else, so this is about landing somebody on a screen
  // they can use rather than about the data.
  if (!farmId || !canManage) redirect(`${homePathFor(profile.role)}?denied=1`);

  const supabase = await createClient();
  const { data: credentialData } = await supabase
    .from("driver_credentials")
    .select(
      "id, farm_id, user_id, person_name, type, code, number, issued_on, expiry_date, reminder_lead_days, notes",
    )
    .eq("farm_id", farmId)
    .is("deleted_at", null);

  const credentials = (credentialData as CredentialRow[] | null) ?? [];

  /**
   * The people this farm could file a document against.
   *
   * Read with the service client for exactly the reason `/team` does: `users` is readable
   * only within a farm, and the names wanted here belong to people whose primary farm may
   * be another one on the same account. Scoped to this farm's own members, never a
   * directory scan.
   */
  const service = createServiceClient();
  const { data: peopleData } = await service
    .from("users")
    .select("id, name, email, role")
    .eq("farm_id", farmId)
    .eq("active", true)
    .is("deleted_at", null)
    .order("name", { ascending: true });
  const people = (peopleData ?? []) as { id: string; name: string | null; email: string | null; role: string }[];
  const nameById = new Map(people.map((p) => [p.id, p.name?.trim() || p.email || ""]));

  const rows = credentials
    .map((c) => ({ row: c, state: credentialState(c) }))
    .sort((a, b) => expiryOrder(a.state) - expiryOrder(b.state)
      || (a.row.expiry_date ?? "9999").localeCompare(b.row.expiry_date ?? "9999")
      || credentialPerson(a.row, nameById).localeCompare(credentialPerson(b.row, nameById)));

  const expired = rows.filter((r) => r.state === "expired").length;
  const expiring = rows.filter((r) => r.state === "expiring").length;

  const renewing = sp.renew && rows.find((r) => r.row.id === sp.renew);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 text-2xl font-bold tracking-tight text-ink">
            {t("credentials.title", locale)}
          </h1>
          <PageInfoButton infoKey="credentials" locale={locale} />
        </div>
        <p className="mt-1 text-sm text-sand-600">{t("credentials.lead", locale)}</p>
      </div>

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash
        tone="success"
        message={
          sp.saved === "credential-added"
            ? t("credentials.savedAdded", locale)
            : sp.saved === "credential-renewed"
              ? t("credentials.savedRenewed", locale)
              : sp.saved === "credential-removed"
                ? t("credentials.savedRemoved", locale)
                : undefined
        }
      />

      {/* The answer before the list: how many people cannot legally do their job today.
          Both tiles are rendered even at zero, so "nothing is wrong" is something the
          screen SAYS rather than something a farmer infers from an absence. */}
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label={t("credentials.statExpired", locale)}
          value={String(expired)}
          tone={countTone(expired, "expired")}
        />
        <Stat
          label={t("credentials.statExpiring", locale)}
          value={String(expiring)}
          tone={countTone(expiring, "expiring")}
        />
      </div>

      {rows.length === 0 ? (
        <GetStarted
          title={t("credentials.emptyTitle", locale)}
          hint={t("credentials.emptyBody", locale)}
        />
      ) : (
        <Card flush>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <CardTitle>{t("credentials.listTitle", locale)}</CardTitle>
          </div>
          {/* Cards, not a table. Seven columns of dates on a 360px phone is a horizontal
              scroller, and this is a screen somebody reads standing next to a truck. */}
          <ul className="divide-y divide-sand-200">
            {rows.map(({ row, state }) => {
              const look = credentialLook(state);
              return (
                <li key={row.id} className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">
                        {credentialPerson(row, nameById)}
                      </p>
                      <p className="mt-0.5 text-sm text-sand-600">
                        {enumLabel("credentialType", row.type, locale)}
                        {row.code ? ` · ${row.code}` : ""}
                      </p>
                    </div>
                    <Badge tone={look.tone}>{t(look.labelKey, locale)}</Badge>
                  </div>

                  <p className="mt-2 text-sm text-sand-700">
                    {row.expiry_date
                      ? t(state === "expired" ? "credentials.expiredOn" : "credentials.expiresOn", locale)
                          .replace("{date}", shortDate(row.expiry_date, locale))
                      : t("credentials.noExpiry", locale)}
                  </p>
                  {row.notes ? (
                    <p className="mt-1 text-sm text-sand-600">{row.notes}</p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Link
                      href={`/team/licences?renew=${row.id}`}
                      className={buttonVariants({ variant: "secondary", size: "sm" })}
                    >
                      {t("credentials.renew", locale)}
                    </Link>
                    <ConfirmDialog
                      triggerLabel={t("credentials.remove", locale)}
                      triggerVariant="ghost"
                      triggerSize="sm"
                      triggerIcon={<TrashIcon />}
                      title={t("credentials.removeTitle", locale)}
                      intro={t("credentials.removeBody", locale)}
                      confirmLabel={t("credentials.remove", locale)}
                      cancelLabel={t("credentials.removeNo", locale)}
                      action={removeDriverCredential}
                    >
                      <input type="hidden" name="id" value={row.id} />
                    </ConfirmDialog>
                  </div>

                  {/* The renewal form opens IN PLACE, on the row it is about. A modal that
                      asks "new expiry date" with the person's name three lines away is how
                      a farm renews the wrong licence. */}
                  {renewing && renewing.row.id === row.id ? (
                    <form
                      action={renewDriverCredential}
                      className="mt-3 grid gap-3 rounded-lg border border-sand-200 bg-sand-50 p-3 sm:grid-cols-3"
                    >
                      <input type="hidden" name="id" value={row.id} />
                      <Field label={t("credentials.newExpiry", locale)} htmlFor={`exp-${row.id}`} required>
                        <Input
                          id={`exp-${row.id}`}
                          name="expiry_date"
                          type="date"
                          required
                          defaultValue={row.expiry_date ?? ""}
                        />
                      </Field>
                      <Field label={t("credentials.issuedOn", locale)} htmlFor={`iss-${row.id}`}>
                        <Input
                          id={`iss-${row.id}`}
                          name="issued_on"
                          type="date"
                          defaultValue={row.issued_on ?? ""}
                        />
                      </Field>
                      <Field label={t("credentials.number", locale)} htmlFor={`num-${row.id}`}>
                        <Input id={`num-${row.id}`} name="number" defaultValue={row.number ?? ""} />
                      </Field>
                      <div className="sm:col-span-3">
                        <SubmitButton variant="primary">
                          {t("credentials.saveRenewal", locale)}
                        </SubmitButton>
                      </div>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Behind a disclosure: capture is the occasional job on this screen, and reading it
          is the daily one. */}
      <details className="group rounded-2xl border border-sand-200 bg-surface shadow-xs">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 sm:p-5">
          <span className="font-semibold text-ink">{t("credentials.addTitle", locale)}</span>
          <ChevronDownIcon className="shrink-0 text-sand-500 transition-transform group-open:rotate-180" />
        </summary>
        <form action={addDriverCredential} className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5 sm:pb-5">
          <Field
            label={t("credentials.person", locale)}
            htmlFor="dc-user"
            hint={t("credentials.personHint", locale)}
          >
            <Select id="dc-user" name="user_id" defaultValue="">
              <option value="">{t("credentials.personOther", locale)}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name?.trim() || p.email || p.id.slice(0, 8)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t("credentials.personName", locale)}
            htmlFor="dc-name"
            hint={t("credentials.personNameHint", locale)}
          >
            <Input id="dc-name" name="person_name" maxLength={80} />
          </Field>
          <Field label={t("credentials.type", locale)} htmlFor="dc-type">
            <Select id="dc-type" name="type" defaultValue="drivers_licence">
              {CREDENTIAL_TYPES.map((k) => (
                <option key={k} value={k}>
                  {enumLabel("credentialType", k, locale)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t("credentials.code", locale)}
            htmlFor="dc-code"
            hint={t("credentials.codeHint", locale)}
          >
            <Input id="dc-code" name="code" maxLength={20} />
          </Field>
          <Field label={t("credentials.number", locale)} htmlFor="dc-number">
            <Input id="dc-number" name="number" maxLength={40} />
          </Field>
          <Field label={t("credentials.issuedOn", locale)} htmlFor="dc-issued">
            <Input id="dc-issued" name="issued_on" type="date" />
          </Field>
          <Field
            label={t("credentials.expiry", locale)}
            htmlFor="dc-expiry"
            hint={t("credentials.expiryHint", locale)}
          >
            <Input id="dc-expiry" name="expiry_date" type="date" />
          </Field>
          <Field
            label={t("credentials.lead", locale)}
            htmlFor="dc-lead"
            hint={t("credentials.leadHint", locale)}
          >
            <Input id="dc-lead" name="reminder_lead_days" inputMode="numeric" defaultValue="30" />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("credentials.notes", locale)} htmlFor="dc-notes">
              <Input id="dc-notes" name="notes" maxLength={200} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <SubmitButton variant="primary">{t("credentials.add", locale)}</SubmitButton>
          </div>
        </form>
      </details>

      <p className="text-sm text-sand-600">
        <Link href="/team" className="font-medium text-brand-ink underline">
          {t("credentials.backToTeam", locale)}
        </Link>
      </p>
    </div>
  );
}
