import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { relativeDate } from "@/lib/format";
import { resolveFault, acknowledgeFault, startFault, assignFault } from "./actions";
import { createJobCard } from "@/app/(app)/jobcards/actions";
import { FaultCapture } from "@/components/fault-capture";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { AllClear } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { FaultsIcon, JobCardsIcon } from "@/components/ui/icons";
import { UrgencyStatus, FaultStatus } from "@/components/ui/status";

type Fault = {
  id: string; machine_id: string; farm_id: string; description: string | null;
  category: string | null; urgency: string | null; status: string;
  created_at: string; reporter_name: string | null; job_card_id: string | null;
  assigned_to: string | null; lat: number | null; lng: number | null;
};
type Attach = { id: string; parent_id: string; kind: string; storage_path: string | null };

export default async function FaultsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.language;
  const supabase = await createClient();

  const { data: fData } = await supabase
    .from("faults")
    .select("id, machine_id, farm_id, description, category, urgency, status, created_at, reporter_name, job_card_id, assigned_to, lat, lng")
    .is("deleted_at", null)
    .order("status")
    .order("created_at", { ascending: false })
    .limit(50);
  const rawFaults = (fData as Fault[] | null) ?? [];

  /*
    Same query, sorted by how bad it is. `.order("status")` is alphabetical, so
    "acknowledged" came before "open" and a machine standing dead could sit below a
    torn seat. Re-ranked in memory: stopped, then limping, then just-so-you-know, with
    anything resolved last.
  */
  const URGENCY_RANK: Record<string, number> = { stopped: 0, limping: 1, can_work: 2 };
  const faults = [...rawFaults].sort((a, b) => {
    const ar = a.status === "resolved" ? 1 : 0;
    const br = b.status === "resolved" ? 1 : 0;
    if (ar !== br) return ar - br;
    const au = URGENCY_RANK[a.urgency ?? ""] ?? 3;
    const bu = URGENCY_RANK[b.urgency ?? ""] ?? 3;
    if (au !== bu) return au - bu;
    return b.created_at.localeCompare(a.created_at);
  });

  const { data: mData } = await supabase.from("machines").select("id, name, farm_id").is("deleted_at", null).order("name");
  const machines = (mData as { id: string; name: string; farm_id: string }[] | null) ?? [];
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));

  // Farm users for the assignee name map + the "assign to" select (FR-7.3).
  const { data: uData } = await supabase.from("users").select("id, name").eq("active", true).is("deleted_at", null).order("name");
  const users = (uData as { id: string; name: string }[] | null) ?? [];
  const userName = new Map(users.map((u) => [u.id, u.name]));

  // Attachments for the listed faults, with signed URLs (farm-scoped by storage RLS).
  const faultIds = faults.map((f) => f.id);
  const { data: aData } = faultIds.length
    ? await supabase.from("attachments").select("id, parent_id, kind, storage_path").eq("parent_type", "fault").is("deleted_at", null).in("parent_id", faultIds)
    : { data: [] };
  const attachments = (aData as Attach[] | null) ?? [];
  const signed = new Map<string, { kind: string; url: string }[]>();
  await Promise.all(
    attachments.map(async (a) => {
      if (!a.storage_path) return;
      const bucket = a.kind === "voice" ? "fault-voice" : "fault-photos";
      const { data: s } = await supabase.storage.from(bucket).createSignedUrl(a.storage_path, 3600);
      if (s?.signedUrl) {
        const list = signed.get(a.parent_id) ?? [];
        list.push({ kind: a.kind, url: s.signedUrl });
        signed.set(a.parent_id, list);
      }
    })
  );

  const canReport = ["owner", "manager", "mechanic", "operator"].includes(profile.role);
  const canJob = ["owner", "manager", "mechanic", "workshop"].includes(profile.role);
  const canResolve = ["owner", "manager", "mechanic"].includes(profile.role);

  const openFaults = faults.filter((f) => f.status !== "resolved");
  const resolvedFaults = faults.filter((f) => f.status === "resolved");
  const openCount = openFaults.length;
  const resolvedCount = resolvedFaults.length;
  const stoppedCount = openFaults.filter((f) => f.urgency === "stopped").length;
  const lastResolved = resolvedFaults[0] ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[1.6rem] font-bold leading-tight tracking-tight text-sand-950">
          {t("faults.titleNew", locale)}
        </h1>
        <p className="mt-1 text-sm text-sand-500">
          {stoppedCount > 0 ? (
            <span className="font-medium text-status-overdue">
              {stoppedCount === 1
                ? t("faults.oneStandingStill", locale)
                : t("faults.standingStill", locale).replace("{n}", String(stoppedCount))}
            </span>
          ) : null}
          {stoppedCount > 0 ? " · " : ""}
          {t("faults.stillOpen", locale)} {openCount} · {t("faults.sortedOut", locale)} {resolvedCount}
        </p>
      </div>
      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {canReport && machines.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("faults.report", locale)}</CardTitle></CardHeader>
          <FaultCapture endpoint="/api/faults" machines={machines.map((m) => ({ id: m.id, name: m.name }))} redirectTo="/faults?saved=1" locale={locale} variant="app" />
        </Card>
      ) : null}

      {openCount === 0 ? (
        <AllClear
          icon={<FaultsIcon />}
          title={t("faults.nothingBrokenTitle", locale)}
          hint={
            lastResolved
              ? `${t("faults.nothingBrokenHint", locale)} ${t("faults.lastSorted", locale).replace("{when}", relativeDate(lastResolved.created_at, locale))}`
              : t("faults.nothingBrokenHint", locale)
          }
        />
      ) : null}

      {faults.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {faults.map((f) => {
            const media = signed.get(f.id) ?? [];
            const resolved = f.status === "resolved";
            return (
              <li key={f.id}>
                <Card className={resolved ? "opacity-70" : undefined}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-sand-900">{nameById[f.machine_id] ?? "—"}</p>
                      <p className="mt-0.5 text-sm text-sand-700">{f.description}</p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-sand-500">
                        <FaultStatus value={f.status} locale={locale} />
                        <span>
                          {f.reporter_name
                            ? t("faults.reportedByWhen", locale)
                                .replace("{name}", f.reporter_name)
                                .replace("{when}", relativeDate(f.created_at, locale))
                            : relativeDate(f.created_at, locale)}
                        </span>
                        <span className={f.assigned_to ? "" : "font-medium text-status-due"}>
                          {f.assigned_to
                            ? `${t("faults.assignedTo", locale)} ${userName.get(f.assigned_to) ?? "—"}`
                            : t("faults.nobodyLooking", locale)}
                        </span>
                      </p>
                      {f.lat != null && f.lng != null ? (
                        <a
                          href={`https://www.google.com/maps?q=${f.lat},${f.lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="focus-ring mt-1 inline-flex items-center gap-1 rounded text-xs font-medium text-brand-700"
                        >
                          {t("faults.viewLocation", locale)}
                        </a>
                      ) : null}
                    </div>
                    {f.urgency ? <UrgencyStatus value={f.urgency} locale={locale} className="shrink-0" /> : null}
                  </div>

                  {media.length > 0 ? (
                    <div className="mt-3 flex flex-wrap items-start gap-3">
                      {media.filter((m) => m.kind === "photo").map((m, i) => (
                        <a key={i} href={m.url} target="_blank" rel="noopener noreferrer" className="focus-ring rounded-xl">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={m.url}
                            alt={t("faults.viewPhoto", locale)}
                            className={`rounded-xl object-cover ring-1 ring-sand-200 ${
                              f.urgency === "stopped" ? "h-[132px] w-[132px]" : "h-24 w-24"
                            }`}
                          />
                        </a>
                      ))}
                      {media.filter((m) => m.kind === "voice").map((m, i) => (
                        <figure key={i} className="rounded-xl border border-sand-200 bg-sand-50 p-2.5">
                          <figcaption className="mb-1.5 text-xs font-medium text-sand-600">
                            {f.reporter_name
                              ? t("faults.voiceNote", locale).replace("{name}", f.reporter_name)
                              : t("faults.voiceNoteAnon", locale)}
                          </figcaption>
                          <audio controls src={m.url} className="h-10 max-w-[240px]" aria-label={t("faults.playVoiceNote", locale)} />
                        </figure>
                      ))}
                    </div>
                  ) : null}

                  {!resolved ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {/* One green action per row — every one of these used to be a
                          `variant="ghost" size="sm"`, so when everything is quiet
                          nothing is obvious. */}
                      {canJob && !f.job_card_id ? (
                        <form action={createJobCard}>
                          <input type="hidden" name="machine_id" value={f.machine_id} />
                          <input type="hidden" name="farm_id" value={f.farm_id} />
                          <input type="hidden" name="fault_id" value={f.id} />
                          <input type="hidden" name="type" value="repair" />
                          <SubmitButton variant="primary" leftIcon={<JobCardsIcon />}>
                            {t("faults.makeJobCard", locale)}
                          </SubmitButton>
                        </form>
                      ) : null}
                      {canJob && f.status === "open" ? (
                        <form action={acknowledgeFault}>
                          <input type="hidden" name="id" value={f.id} />
                          <Button type="submit" variant="ghost" size="sm">{t("faults.acknowledge", locale)}</Button>
                        </form>
                      ) : null}
                      {canJob && (f.status === "open" || f.status === "acknowledged") ? (
                        <form action={startFault}>
                          <input type="hidden" name="id" value={f.id} />
                          <Button type="submit" variant="ghost" size="sm">{t("faults.startWork", locale)}</Button>
                        </form>
                      ) : null}
                      {canResolve && users.length > 0 ? (
                        <form action={assignFault} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={f.id} />
                          <Select name="assigned_to" defaultValue={f.assigned_to ?? ""} aria-label={t("faults.assignTo", locale)} className="h-9 py-0 text-sm">
                            <option value="">{t("faults.unassigned", locale)}</option>
                            {users.map((u) => (
                              <option key={u.id} value={u.id}>{u.name}</option>
                            ))}
                          </Select>
                          <Button type="submit" variant="ghost" size="sm">{t("faults.assign", locale)}</Button>
                        </form>
                      ) : null}
                      {canResolve ? (
                        <form action={resolveFault}>
                          <input type="hidden" name="id" value={f.id} />
                          <Button type="submit" variant="ghost" size="sm">{t("faults.itsSorted", locale)}</Button>
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
