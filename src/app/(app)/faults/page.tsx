import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { resolveFault } from "./actions";
import { createJobCard } from "@/app/(app)/jobcards/actions";
import { FaultCapture } from "@/components/fault-capture";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { FaultsIcon } from "@/components/ui/icons";

type Fault = {
  id: string; machine_id: string; farm_id: string; description: string | null;
  category: string | null; urgency: string | null; status: string;
  created_at: string; reporter_name: string | null; job_card_id: string | null;
};
type Attach = { id: string; parent_id: string; kind: string; storage_path: string | null };

const urgencyTone = (u: string | null): BadgeTone =>
  (u ?? "").includes("stop") ? "danger" : (u ?? "").includes("limp") ? "warning" : "neutral";

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
    .select("id, machine_id, farm_id, description, category, urgency, status, created_at, reporter_name, job_card_id")
    .is("deleted_at", null)
    .order("status")
    .order("created_at", { ascending: false })
    .limit(50);
  const faults = (fData as Fault[] | null) ?? [];

  const { data: mData } = await supabase.from("machines").select("id, name, farm_id").is("deleted_at", null).order("name");
  const machines = (mData as { id: string; name: string; farm_id: string }[] | null) ?? [];
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));

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

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("faults.title", locale)}</h1>
      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {canReport && machines.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("faults.report", locale)}</CardTitle></CardHeader>
          <FaultCapture endpoint="/api/faults" machines={machines.map((m) => ({ id: m.id, name: m.name }))} redirectTo="/faults?saved=1" locale={locale} variant="app" />
        </Card>
      ) : null}

      {faults.length === 0 ? (
        <EmptyState icon={<FaultsIcon />} title={t("faults.empty", locale)} hint={t("faults.emptyHint", locale)} />
      ) : (
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
                      <p className="mt-1 text-xs text-sand-400">
                        {t(`faultStatus.${f.status}`, locale)} · {new Date(f.created_at).toLocaleDateString("en-ZA")}
                        {f.reporter_name ? ` · ${t("faults.reportedBy", locale)} ${f.reporter_name}` : ""}
                      </p>
                    </div>
                    {f.urgency ? <Badge tone={urgencyTone(f.urgency)} className="shrink-0">{t(`urgency.${f.urgency}`, locale)}</Badge> : null}
                  </div>

                  {media.length > 0 ? (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {media.filter((m) => m.kind === "photo").map((m, i) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <a key={i} href={m.url} target="_blank" rel="noopener noreferrer" className="focus-ring rounded-lg">
                          <img src={m.url} alt={t("faults.viewPhoto", locale)} className="h-16 w-16 rounded-lg object-cover" />
                        </a>
                      ))}
                      {media.filter((m) => m.kind === "voice").map((m, i) => (
                        <audio key={i} controls src={m.url} className="h-9 max-w-[220px]" />
                      ))}
                    </div>
                  ) : null}

                  {!resolved ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {canJob && !f.job_card_id ? (
                        <form action={createJobCard}>
                          <input type="hidden" name="machine_id" value={f.machine_id} />
                          <input type="hidden" name="farm_id" value={f.farm_id} />
                          <input type="hidden" name="fault_id" value={f.id} />
                          <input type="hidden" name="type" value="repair" />
                          <SubmitButton variant="secondary" size="sm">{t("faults.toJobCard", locale)}</SubmitButton>
                        </form>
                      ) : null}
                      {canResolve ? (
                        <form action={resolveFault}>
                          <input type="hidden" name="id" value={f.id} />
                          <Button type="submit" variant="ghost" size="sm">{t("faults.resolve", locale)}</Button>
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
