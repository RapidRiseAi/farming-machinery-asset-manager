import { requireRole } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { exportIsFresh } from "@/lib/farm-closure";
import { dateTime, num } from "@/lib/format";
import { t } from "@/lib/i18n";
import { downloadLabels } from "@/lib/interaction-labels";
import { must } from "@/lib/supabase/must";
import { createServiceClient } from "@/lib/supabase/service";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DownloadLink } from "@/components/ui/download-link";
import { Flash } from "@/components/ui/flash";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { requestClosure } from "./actions";

/**
 * Closing an account for good. The owner alone, and it deletes nothing: the last step is a
 * link in their email. It lays out exactly what goes and what stays, and hands them everything
 * first, because after that there is no way back.
 */
export const dynamic = "force-dynamic";

type StoredFile = { bucket_id: string; name: string; size: number };

export default async function CloseAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const profile = await requireRole(["owner"]);
  const sp = await searchParams;
  const locale = profile.lang;
  const farmId = profile.farm_id ?? "";

  const svc = createServiceClient();
  const farm = must(
    await svc.from("farms").select("name, last_export_at").eq("id", farmId).maybeSingle(),
    "close:farm",
  ) as { name: string; last_export_at: string | null } | null;
  const files = (must(await svc.rpc("farm_file_objects", { p_farm: farmId }), "close:files") ?? []) as StoredFile[];

  const buckets = [...new Set(files.map((f) => f.bucket_id))].map((bucket) => {
    const mine = files.filter((f) => f.bucket_id === bucket);
    const megabytes = mine.reduce((sum, f) => sum + Number(f.size), 0) / (1024 * 1024);
    return { bucket, count: mine.length, megabytes };
  });
  const exported = exportIsFresh(farm?.last_export_at);
  const labels = downloadLabels(locale);

  return (
    <PageContainer>
      <PageHeader
        title={t("closure.title", locale)}
        lead={t("closure.lead", locale).replace("{business}", () => farm?.name ?? "")}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.sent ? t("closure.sentFlash", locale) : undefined} />

      <Card>
        <CardHeader><CardTitle as="h3">{t("closure.whatGoes", locale)}</CardTitle></CardHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-sand-700">
          <li>{t("closure.goes1", locale)}</li>
          <li>{t("closure.goes2", locale)}</li>
          <li>{t("closure.goes3", locale)}</li>
          <li>{t("closure.goes4", locale)}</li>
        </ul>
        <h4 className="mt-4 text-sm font-semibold text-sand-900">{t("closure.whatStays", locale)}</h4>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-sand-700">
          <li>{t("closure.stays1", locale)}</li>
          <li>{t("closure.stays2", locale)}</li>
          <li>{t("closure.stays3", locale)}</li>
        </ul>
      </Card>

      <Card>
        <CardHeader><CardTitle as="h3">{t("closure.step1", locale)}</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-sand-600">{t("closure.step1Hint", locale)}</p>
        <div className="flex flex-wrap gap-2">
          <DownloadLink
            href={`/api/farm/export?farm=${farmId}`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
            labels={labels}
          >
            {t("closure.downloadRecords", locale)}
          </DownloadLink>
          {buckets.map((b) => (
            <DownloadLink
              key={b.bucket}
              href={`/api/farm/export/files?farm=${farmId}&bucket=${encodeURIComponent(b.bucket)}`}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
              labels={labels}
            >
              {t(`closure.bucket.${b.bucket}`, locale)} ({num(b.count)}, {num(b.megabytes)} MB)
            </DownloadLink>
          ))}
        </div>
        <p className="mt-3 text-sm text-sand-600">
          {exported && farm?.last_export_at
            ? t("closure.exportedAt", locale).replace("{date}", () => dateTime(farm.last_export_at, locale))
            : t("closure.exportNeeded", locale)}
        </p>
      </Card>

      <Card>
        <CardHeader><CardTitle as="h3">{t("closure.step2", locale)}</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-sand-600">
          {t("closure.step2Hint", locale).replace("{email}", () => profile.email ?? "")}
        </p>
        <form action={requestClosure} className="space-y-3">
          <Checkbox name="understood" required label={t("closure.understood", locale)} />
          <SubmitButton variant="danger">{t("closure.send", locale)}</SubmitButton>
        </form>
      </Card>
    </PageContainer>
  );
}
