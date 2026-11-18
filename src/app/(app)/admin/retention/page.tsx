import { requireRole } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { shortDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { retentionDeletionArmed } from "@/lib/retention";
import { must, mustAll } from "@/lib/supabase/must";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Disclosure } from "@/components/ui/disclosure";
import { Fact, FactList } from "@/components/ui/facts";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { placeHold, releaseHold, runSchedule, setDeletion } from "./actions";

/**
 * Deletion after the owner's reading window (20261120120000). Internal and English, like the rest
 * of the console. What would be deleted, when, why not yet, and the holds; the switch is the
 * founder's, and the deployment needs RETENTION_DELETION=enabled as well.
 */
export const dynamic = "force-dynamic";

type Schedule = {
  id: string; farm_id: string; reason: string; retrieval_ends_on: string; delete_after: string; status: string;
  first_warned_at: string | null; warnings_sent: number[]; attempts: number; last_error: string | null;
  preview: { rows_removed?: number; files?: number; file_bytes?: number; logins_removed?: number; logins_moved?: number;
    checks?: { blocked_by?: string[] } } | null;
  previewed_at: string | null;
  farms: { name: string } | null;
};
type Hold = { id: string; farm_id: string; kind: string; reason: string; placed_at: string };

export default async function RetentionPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const supabase = await createClient();
  const results = await Promise.all([
    supabase.from("retention_settings").select("deletion_enabled, delay_days, enabled_at").eq("singleton", true).maybeSingle(),
    supabase.from("farm_retention_schedules")
      .select("id, farm_id, reason, retrieval_ends_on, delete_after, status, first_warned_at, warnings_sent, attempts, last_error, preview, previewed_at, farms(name)")
      .order("delete_after").limit(200),
    supabase.from("farm_retention_holds").select("id, farm_id, kind, reason, placed_at").is("released_at", null).order("placed_at").limit(200),
  ]);
  mustAll(results, "admin-retention");
  const settings = results[0].data as { deletion_enabled: boolean; delay_days: number; enabled_at: string | null } | null;
  const schedules = (results[1].data ?? []) as unknown as Schedule[];
  const holds = (must(results[2], "admin-retention:holds") ?? []) as Hold[];
  const armed = retentionDeletionArmed();
  const on = !!settings?.deletion_enabled;

  return (
    <PageContainer>
      <PageHeader title="Deletion after the reading window" lead="Businesses whose subscription ended unpaid or cancelled, after the owner's 90 days. A dry run until both switches are on." />
      {sp.error ? <Flash tone="error" message={errorMessage(sp.error, locale)} /> : null}
      {sp.saved ? <Flash tone="success" message={t("common.saved", locale)} /> : null}

      <Card>
        <CardHeader><CardTitle as="h3">The switch</CardTitle></CardHeader>
        <FactList>
          <Fact label="Database setting" value={on ? <Badge tone="danger">On</Badge> : <Badge tone="ok">Off (dry run)</Badge>}
            hint={settings?.enabled_at ? `Switched on ${shortDate(settings.enabled_at, "en")}` : undefined} />
          <Fact label="Deployment (RETENTION_DELETION)" value={armed ? "enabled" : "not set"} />
          <Fact label="Days after the reading window" value={String(settings?.delay_days ?? 30)}
            hint="And never sooner than 30 days after the owner's first warning." />
        </FactList>
        <p className="mt-2 text-sm text-sand-600">
          While off, nobody is warned and nothing is deleted; each night the schedule and a preview are brought up to date.
          A deletion is the owner&apos;s own permanent closure (billing records kept five years) with reason &quot;retention&quot;.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={runSchedule}><SubmitButton variant="secondary">Run the schedule and preview now</SubmitButton></form>
          {on ? (
            <ConfirmDialog action={setDeletion} triggerLabel="Switch deletion off" title="Switch deletion off"
              intro="No more warnings or deletions until it is switched on again." confirmLabel="Switch off"
              cancelLabel="Cancel" closeLabel="Close" tone="brand">
              <input type="hidden" name="enabled" value="false" />
            </ConfirmDialog>
          ) : (
            <DialogForm trigger="Switch deletion on" title="Switch scheduled deletion on" closeLabel="Close" triggerVariant="secondary"
              description="The founder's decision. Owners start receiving warnings; deletion follows no sooner than 30 days after each first warning. Type DELETE AFTER THE READING WINDOW to confirm.">
              <form action={setDeletion}>
                <input type="hidden" name="enabled" value="true" />
                <DialogFields columns={1}>
                  <Field label="Confirmation" htmlFor="ret-phrase" required><Input id="ret-phrase" name="phrase" required autoComplete="off" /></Field>
                </DialogFields>
                <DialogActions cancelLabel="Cancel"><SubmitButton>Switch on</SubmitButton></DialogActions>
              </form>
            </DialogForm>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle as="h3">Schedule ({schedules.length})</CardTitle></CardHeader>
        {schedules.length === 0 ? <p className="text-sm text-sand-600">No business is scheduled.</p> : (
          <ul className="flex flex-col gap-3 text-sm text-sand-800">
            {schedules.map((s) => {
              const farmHolds = holds.filter((h) => h.farm_id === s.farm_id);
              return (
                <li key={s.id} className="rounded-xl border border-sand-200 p-3">
                  <p className="font-semibold text-sand-900">{s.farms?.name ?? s.farm_id}: {s.status}</p>
                  <FactList>
                    <Fact label="Ended" value={s.reason} />
                    <Fact label="Last reading day" value={shortDate(s.retrieval_ends_on, "en")} />
                    <Fact label="Earliest deletion" value={shortDate(s.delete_after, "en")}
                      hint={s.first_warned_at ? `First warned ${shortDate(s.first_warned_at, "en")}; stages ${s.warnings_sent.join(", ")}` : "Not warned (deletion off or not yet)"} />
                    <Fact label="Would remove" value={`${s.preview?.rows_removed ?? 0} records, ${s.preview?.files ?? 0} files, ${s.preview?.logins_removed ?? 0} login(s); ${s.preview?.logins_moved ?? 0} moved to another business`} />
                    <Fact label="Not yet because" value={(s.preview?.checks?.blocked_by ?? []).join(", ") || "nothing: due"} />
                    {s.last_error ? <Fact label="Last failure" value={`${s.last_error} (${s.attempts})`} /> : null}
                  </FactList>
                  {farmHolds.length > 0 ? (
                    <Disclosure variant="inline" summary={`Holds (${farmHolds.length})`}>
                      <ul className="flex flex-col gap-2">
                        {farmHolds.map((h) => (
                          <li key={h.id} className="flex flex-wrap items-center justify-between gap-2">
                            <span>{h.kind}: {h.reason} ({shortDate(h.placed_at, "en")})</span>
                            <form action={releaseHold}><input type="hidden" name="hold_id" value={h.id} /><SubmitButton variant="secondary" size="sm">Release</SubmitButton></form>
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  ) : null}
                  <div className="mt-2">
                    <DialogForm trigger="Place a hold" title="Place a hold" closeLabel="Close" triggerVariant="secondary" triggerSize="sm">
                      <form action={placeHold}>
                        <input type="hidden" name="farm_id" value={s.farm_id} />
                        <DialogFields columns={1}>
                          <Field label="Kind" htmlFor={`hold-kind-${s.id}`}>
                            <Select id={`hold-kind-${s.id}`} name="kind" defaultValue="legal">
                              <option value="legal">Legal hold</option>
                              <option value="dispute">Dispute</option>
                              <option value="support">Support case</option>
                              <option value="other">Other</option>
                            </Select>
                          </Field>
                          <Field label="Reason" htmlFor={`hold-reason-${s.id}`} required><Textarea id={`hold-reason-${s.id}`} name="reason" rows={2} required maxLength={500} /></Field>
                        </DialogFields>
                        <DialogActions cancelLabel="Cancel"><SubmitButton>Place the hold</SubmitButton></DialogActions>
                      </form>
                    </DialogForm>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
