import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/supabase/must";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { shortDate } from "@/lib/format";
import { COMPANY } from "@/lib/legal";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Flash } from "@/components/ui/flash";
import { Fact, FactList } from "@/components/ui/facts";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { PlusIcon } from "@/components/ui/icons";
import { hoursLine, promiseLine, type SupportContact } from "@/components/support/support-parts";

import { removeSupportHoliday, setSupportHoliday, updateSupportSettings } from "../actions";

export const dynamic = "force-dynamic";

/**
 * The support desk's calendar and the channels customers are shown: data, not code.
 *
 * Founder defaults (2026-10-28): weekdays 09:00 to 17:00 South African time; 09:00 to
 * 16:00 is answered by 17:00 that day, anything else by 12:00 the next working day; South
 * African public holidays are closed (2026 and 2027 seeded). The human phone and WhatsApp
 * numbers stay blank, and hidden from customers, until Rapid Rise confirms and types them.
 */
export default async function SupportSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; deleted?: string }>;
}) {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const supabase = await createClient();

  const results = await Promise.all([
    supabase.rpc("support_contact"),
    supabase.from("support_holidays").select("day, name").order("day"),
  ]);
  const contactRows = must(results[0], "support-settings:contact");
  const holidayRows = must(results[1], "support-settings:holidays");
  const c = ((contactRows as SupportContact[] | null) ?? [])[0] ?? null;
  const holidays = (holidayRows as { day: string; name: string }[] | null) ?? [];
  // Today and later first: a past holiday is history, kept only for old deadlines.
  // Today in South Africa, not on the server's UTC clock (CLAUDE.md, SAST dates).
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date());
  const coming = holidays.filter((h) => h.day >= today);

  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const notSet = t("support.notShownYet", locale);
  const days = c?.working_days?.map(Number) ?? [1, 2, 3, 4, 5];

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={t("support.settingsTitle", locale)}
        lead={t("support.settingsLead", locale)}
        back={{ href: "/admin/support", label: t("support.queueTitle", locale) }}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : sp.deleted ? t("support.holidayRemoved", locale) : undefined} />

      <Card>
        <CardHeader
          action={
            <DialogForm
              trigger={t("common.edit", locale)}
              triggerVariant="secondary"
              triggerSize="sm"
              title={t("support.settingsEditTitle", locale)}
              description={t("support.settingsEditHint", locale)}
              closeLabel={closeLabel}
              size="md"
            >
              <form action={updateSupportSettings}>
                <DialogFields>
                  <div className="sm:col-span-2">
                    <Field label={t("support.channelEmail", locale)} htmlFor="ss-email" required>
                      <Input id="ss-email" name="email" type="email" required defaultValue={c?.email ?? COMPANY.email} />
                    </Field>
                  </div>
                  <Field label={t("support.channelPhone", locale)} htmlFor="ss-phone" hint={t("support.blankHides", locale)}>
                    <Input id="ss-phone" name="phone" type="tel" inputMode="tel" defaultValue={c?.phone ?? ""} />
                  </Field>
                  <Field label={t("support.channelWhatsApp", locale)} htmlFor="ss-wa" hint={t("support.blankHides", locale)}>
                    <Input id="ss-wa" name="whatsapp" type="tel" inputMode="tel" defaultValue={c?.whatsapp ?? ""} />
                  </Field>
                  <Field label={t("support.opensAt", locale)} htmlFor="ss-opens" required>
                    <Input id="ss-opens" name="opens_at" type="time" required defaultValue={c?.opens_at ?? "09:00"} />
                  </Field>
                  <Field label={t("support.closesAt", locale)} htmlFor="ss-closes" required>
                    <Input id="ss-closes" name="closes_at" type="time" required defaultValue={c?.closes_at ?? "17:00"} />
                  </Field>
                  <Field label={t("support.cutoff", locale)} htmlFor="ss-cutoff" hint={t("support.cutoffHint", locale)} required>
                    <Input id="ss-cutoff" name="same_day_cutoff" type="time" required defaultValue={c?.same_day_cutoff ?? "16:00"} />
                  </Field>
                  <Field label={t("support.nextDayDue", locale)} htmlFor="ss-next" hint={t("support.nextDayDueHint", locale)} required>
                    <Input id="ss-next" name="next_day_due" type="time" required defaultValue={c?.next_day_due ?? "12:00"} />
                  </Field>
                  <fieldset className="sm:col-span-2">
                    <legend className="text-sm font-medium text-ink">{t("support.workingDays", locale)}</legend>
                    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
                      {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                        <Checkbox
                          key={d}
                          id={`ss-day-${d}`}
                          name="working_days"
                          value={String(d)}
                          defaultChecked={days.includes(d)}
                          label={t(`support.day.d${d}`, locale)}
                        />
                      ))}
                    </div>
                  </fieldset>
                </DialogFields>
                <DialogActions cancelLabel={cancelLabel}>
                  <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                </DialogActions>
              </form>
            </DialogForm>
          }
        >
          <CardTitle>{t("support.settingsCardTitle", locale)}</CardTitle>
        </CardHeader>
        <FactList>
          <Fact label={t("support.hoursLabel", locale)} value={hoursLine(c, locale)} hint={promiseLine(c, locale)} />
          <Fact label={t("support.channelEmail", locale)} value={c?.email ?? COMPANY.email} />
          <Fact label={t("support.channelPhone", locale)} value={c?.phone ?? notSet} muted={!c?.phone} />
          <Fact label={t("support.channelWhatsApp", locale)} value={c?.whatsapp ?? notSet} muted={!c?.whatsapp} />
        </FactList>
      </Card>

      <Card flush>
        <CardHeader
          className="px-4 pt-4"
          action={
            <DialogForm
              trigger={t("support.holidayAdd", locale)}
              triggerIcon={<PlusIcon />}
              triggerVariant="secondary"
              triggerSize="sm"
              title={t("support.holidayAdd", locale)}
              description={t("support.holidayAddHint", locale)}
              closeLabel={closeLabel}
              size="md"
            >
              <form action={setSupportHoliday}>
                <DialogFields columns={1}>
                  <Field label={t("support.holidayDay", locale)} htmlFor="sh-day" required>
                    <Input id="sh-day" name="day" type="date" required />
                  </Field>
                  <Field label={t("support.holidayName", locale)} htmlFor="sh-name" required>
                    <Input id="sh-name" name="name" required maxLength={80} />
                  </Field>
                </DialogFields>
                <DialogActions cancelLabel={cancelLabel}>
                  <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                </DialogActions>
              </form>
            </DialogForm>
          }
        >
          <CardTitle>{t("support.holidaysTitle", locale)}</CardTitle>
        </CardHeader>
        {coming.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-sand-600">{t("support.holidaysEmpty", locale)}</p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>{t("support.holidayDay", locale)}</Th>
                <Th>{t("support.holidayName", locale)}</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {coming.map((h) => (
                <Tr key={h.day}>
                  <Td className="tnum">{shortDate(h.day, locale)}</Td>
                  <Td>{h.name}</Td>
                  <Td className="text-right">
                    <ConfirmDialog
                      action={removeSupportHoliday}
                      triggerLabel={t("common.remove", locale)}
                      triggerVariant="ghost"
                      triggerSize="sm"
                      title={t("support.holidayRemoveTitle", locale).replace("{name}", h.name)}
                      intro={t("support.holidayRemoveBody", locale)}
                      confirmLabel={t("common.remove", locale)}
                      cancelLabel={cancelLabel}
                      closeLabel={closeLabel}
                    >
                      <input type="hidden" name="day" value={h.day} />
                    </ConfirmDialog>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </PageContainer>
  );
}
