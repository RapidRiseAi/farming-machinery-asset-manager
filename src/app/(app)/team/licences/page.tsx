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

import { Card, CardTitle } from "@/components/ui/card";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ActionMenu } from "@/components/ui/action-menu";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { GetStarted } from "@/components/ui/empty-state";
import { CalendarIcon, PlusIcon, TrashIcon } from "@/components/ui/icons";
import { DialogActions, DialogFields, DialogForm, DialogSection } from "@/components/ui/dialog-form";

import { addDriverCredential, removeDriverCredential, renewDriverCredential } from "./actions";
import { OTHER_PERSON } from "./credential-person";

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
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role === "rr_admin") redirect("/admin/farms");
  const locale = profile.lang;
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
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

  // Capture is the occasional job on this screen and reading it is the daily one, which
  // is why it was behind a disclosure. A dialog says the same thing and does not put a
  // ten-field form under the list to say it. What is always to hand (who, which document,
  // when it runs out) stays open; the rest folds under "More details".
  const addDocument = (
    <DialogForm
      trigger={t("credentials.add", locale)}
      triggerIcon={<PlusIcon />}
      title={t("credentials.addTitle", locale)}
      closeLabel={closeLabel}
    >
      <form action={addDriverCredential}>
        <DialogFields>
          <Field
            label={t("credentials.person", locale)}
            htmlFor="dc-user"
            hint={t("credentials.personHint", locale)}
            required
          >
            <Select id="dc-user" name="user_id" defaultValue="" required>
              <option value="" disabled>
                {t("credentials.choosePerson", locale)}
              </option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name?.trim() || p.email || p.id.slice(0, 8)}
                </option>
              ))}
              <option value={OTHER_PERSON}>{t("credentials.personOther", locale)}</option>
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
            label={t("credentials.expiry", locale)}
            htmlFor="dc-expiry"
            hint={t("credentials.expiryHint", locale)}
          >
            <Input id="dc-expiry" name="expiry_date" type="date" />
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
          <DialogSection title={t("credentials.moreDetails", locale)}>
            <Field label={t("credentials.issuedOn", locale)} htmlFor="dc-issued">
              <Input id="dc-issued" name="issued_on" type="date" />
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
          </DialogSection>
        </DialogFields>
        <DialogActions cancelLabel={cancelLabel}>
          <SubmitButton variant="primary">{t("credentials.add", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  return (
    <PageContainer>
      <PageHeader
        title={t("credentials.title", locale)}
        lead={t("credentials.subtitle", locale)}
        infoKey="credentials"
        locale={locale}
        back={{ href: "/team", label: t("team.title", locale) }}
        actions={rows.length > 0 ? addDocument : undefined}
      />

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
          Once there is a record both tiles show, even at zero, so "nothing is wrong" is
          something the screen SAYS rather than something a farmer infers from an
          absence. Before the first record, two zeroes above "nothing recorded yet" said
          the same thing three times, so the empty screen is the GetStarted alone, and
          the add dialog is its action rather than also sitting in the header. */}
      {rows.length > 0 ? (
        <StatGrid columns={2}>
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
        </StatGrid>
      ) : null}

      {rows.length === 0 ? (
        <GetStarted
          title={t("credentials.emptyTitle", locale)}
          hint={t("credentials.emptyBody", locale)}
          action={addDocument}
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
              const person = credentialPerson(row, nameById);
              const docLabel = enumLabel("credentialType", row.type, locale);
              const expiryText = row.expiry_date
                ? t(state === "expired" ? "credentials.expiredOn" : "credentials.expiresOn", locale)
                    .replace("{date}", shortDate(row.expiry_date, locale))
                : t("credentials.noExpiry", locale);
              return (
                <li key={row.id} className="p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words font-semibold text-ink">{person}</p>
                      <p className="mt-0.5 text-sm text-sand-600">
                        {docLabel}
                        {row.code ? ` · ${row.code}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Badge tone={look.tone}>{t(look.labelKey, locale)}</Badge>
                      {/* Titled with the person AND the document, so the renewal can never
                          be for the wrong licence: that is what the old in-place form,
                          reached through a ?renew= page reload, was guarding against. */}
                      <ActionMenu
                        title={`${person} · ${docLabel}`}
                        label={t("common.actions", locale)}
                        closeLabel={closeLabel}
                      >
                        <DialogForm
                          triggerLook="menuItem"
                          trigger={t("credentials.renew", locale)}
                          triggerIcon={<CalendarIcon className="text-base" />}
                          title={t("credentials.renewTitleFor", locale)
                            .replace("{document}", docLabel)
                            .replace("{person}", person)}
                          description={expiryText}
                          closeLabel={closeLabel}
                          size="md"
                        >
                          <form action={renewDriverCredential}>
                            <input type="hidden" name="id" value={row.id} />
                            <DialogFields>
                              <Field label={t("credentials.newExpiry", locale)} htmlFor={`exp-${row.id}`} required>
                                <Input id={`exp-${row.id}`} name="expiry_date" type="date" required />
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
                                <Input id={`num-${row.id}`} name="number" maxLength={40} defaultValue={row.number ?? ""} />
                              </Field>
                            </DialogFields>
                            <DialogActions cancelLabel={cancelLabel}>
                              <SubmitButton variant="primary">{t("credentials.saveRenewal", locale)}</SubmitButton>
                            </DialogActions>
                          </form>
                        </DialogForm>
                        <ConfirmDialog
                          triggerLook="menuItem"
                          triggerLabel={t("credentials.remove", locale)}
                          triggerIcon={<TrashIcon />}
                          title={t("credentials.removeTitle", locale)}
                          intro={t("credentials.removeBody", locale)}
                          confirmLabel={t("credentials.remove", locale)}
                          cancelLabel={t("credentials.removeNo", locale)}
                          closeLabel={closeLabel}
                          action={removeDriverCredential}
                        >
                          <input type="hidden" name="id" value={row.id} />
                        </ConfirmDialog>
                      </ActionMenu>
                    </div>
                  </div>

                  <p className="mt-2 text-sm text-sand-700">{expiryText}</p>
                  {row.notes ? (
                    <p className="mt-1 break-words text-sm text-sand-600">{row.notes}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </PageContainer>
  );
}
