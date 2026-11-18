"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { DownloadLink } from "@/components/ui/download-link";
import { ReportPending } from "@/components/ui/pending-guard";
import { t, type Lang } from "@/lib/i18n";
import type { DownloadLabels } from "@/lib/interaction-labels";
import { newRequestId } from "@/lib/request-id";
import { createSingleFlight } from "@/lib/single-flight";

type Part = { n: number; name: string; bytes: number; sha256: string; entries: number; kind: string };
type Table = { name: string; rows: number; status: string };
type Job = {
  id: string;
  status: "records" | "files" | "finishing" | "ready" | "failed" | "expired" | "cancelled";
  tables: Table[];
  parts: Part[];
  files_total: number;
  files_done: number;
  files_missing: number;
  bytes_total: number;
  bytes_done: number;
  last_error: string | null;
  expires_at: string | null;
  removed_at: string | null;
  created_at: string;
};

const RUNNING = new Set(["records", "files", "finishing"]);
const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0);
const fill = (s: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(v), s);

const ERROR_KEYS: Record<string, string> = {
  "export-limit": "exportJob.errLimit",
  "export-not-allowed": "exportJob.errNotAllowed",
  "retrieval-owner-only": "errors.retrievalOwnerOnly",
  "retrieval-ended": "errors.retrievalEnded",
  "export-gone": "exportJob.errGone",
};

/**
 * The complete export (20261120110000): records AND photos, PDFs and kept voice notes, prepared
 * in steps while this page is open (and finished overnight if it is closed), then offered as
 * numbered ZIP parts and a manifest through private links that last ten minutes and are made
 * again on every press while the archive is kept. What is left out is said, never shown.
 */
export function CompleteExport({ farmId, locale, labels }: { farmId: string; locale: Lang; labels: DownloadLabels }) {
  const [job, setJob] = useState<Job | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const driving = useRef(false);
  const alive = useRef(true);

  const say = useCallback((code: string) => t(ERROR_KEYS[code] ?? "exportJob.errFailed", locale), [locale]);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { cache: "no-store", ...init });
    const body = (await response.json().catch(() => ({}))) as { job?: Job | null; jobs?: Job[]; error?: string; url?: string; outcome?: string };
    if (!response.ok) throw new Error(body.error ?? "export-failed");
    return body;
  }, []);

  // Moves a running job on, one bounded step at a time, while the page is open.
  const drive = useCallback(async (start: Job) => {
    if (driving.current) return;
    driving.current = true;
    let current: Job | null = start;
    let failures = 0;
    try {
      while (alive.current && current && RUNNING.has(current.status) && failures < 3) {
        try {
          const body = await call(`/api/farm/export/jobs/${current.id}/step`, { method: "POST" });
          if (body.job) {
            current = body.job;
            setJob(body.job);
          }
          failures = body.outcome === "error" ? failures + 1 : 0;
          if (body.outcome === "busy") await new Promise((r) => setTimeout(r, 3000));
        } catch (e) {
          failures += 1;
          setError(say(e instanceof Error ? e.message : "export-failed"));
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (failures >= 3) setError(t("exportJob.paused", locale));
    } finally {
      driving.current = false;
    }
  }, [call, locale, say]);

  useEffect(() => {
    alive.current = true;
    call(`/api/farm/export/jobs?farm=${encodeURIComponent(farmId)}`)
      .then((body) => {
        const latest = body.jobs?.[0] ?? null;
        setJob(latest);
        if (latest && RUNNING.has(latest.status)) void drive(latest);
      })
      .catch((e) => setError(say(e instanceof Error ? e.message : "export-failed")))
      .finally(() => setLoaded(true));
    return () => {
      alive.current = false;
    };
  }, [call, drive, farmId, say]);

  const flight = useMemo(() => createSingleFlight<[() => Promise<void>]>(async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(say(e instanceof Error ? e.message : "export-failed"));
    } finally {
      setBusy(false);
    }
  }), [say]);

  const start = () => flight.run(async () => {
    requestId.current ??= newRequestId();
    const body = await call("/api/farm/export/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId.current },
      body: JSON.stringify({ farm: farmId }),
    });
    requestId.current = null;
    if (body.job) {
      setJob(body.job);
      void drive(body.job);
    }
  });

  const download = (n: number) => flight.run(async () => {
    if (!job) return;
    const body = await call(`/api/farm/export/jobs/${job.id}/download?part=${n}`);
    if (body.url) window.location.assign(body.url);
  });

  const retry = () => flight.run(async () => {
    if (!job) return;
    const body = await call(`/api/farm/export/jobs/${job.id}/retry`, { method: "POST" });
    if (body.job) {
      setJob(body.job);
      void drive(body.job);
    }
  });

  const rows = job ? job.tables.reduce((n, tb) => n + tb.rows, 0) : 0;
  const ready = job?.status === "ready" && !job.removed_at;
  const running = !!job && RUNNING.has(job.status);

  return (
    <div className="flex flex-col gap-3 text-sm text-sand-800">
      <ReportPending pending={busy} />
      <p className="leading-relaxed">{t("exportJob.lead", locale)}</p>
      <p className="text-xs leading-relaxed text-sand-600">{t("exportJob.scope", locale)}</p>

      {running && job ? (
        <div role="status" className="rounded-xl border border-sand-200 p-3">
          <p className="font-semibold text-sand-900">
            {job.status === "records"
              ? fill(t("exportJob.progressRecords", locale), { rows: rows.toLocaleString(locale === "af" ? "af-ZA" : "en-ZA") })
              : job.status === "files"
                ? fill(t("exportJob.progressFiles", locale), {
                    done: String(job.files_done + job.files_missing), total: String(job.files_total),
                    mb: megabytes(job.bytes_done), totalMb: megabytes(job.bytes_total),
                  })
                : t("exportJob.progressFinishing", locale)}
          </p>
          <p className="mt-1 text-xs text-sand-600">{t("exportJob.keepOpen", locale)}</p>
        </div>
      ) : null}

      {ready && job ? (
        <div className="rounded-xl border border-sand-200 p-3">
          <p className="font-semibold text-sand-900">
            {fill(t("exportJob.ready", locale), {
              rows: rows.toLocaleString(locale === "af" ? "af-ZA" : "en-ZA"),
              files: String(job.files_done),
              mb: megabytes(job.bytes_done),
            })}
          </p>
          {job.expires_at ? (
            <p className="mt-1 text-xs text-sand-600">
              {fill(t("exportJob.keptUntil", locale), { date: new Date(job.expires_at).toLocaleString(locale === "af" ? "af-ZA" : "en-ZA") })}
            </p>
          ) : null}
          <ul className="mt-2 flex flex-col gap-2">
            {job.parts.map((p) => (
              <li key={p.n} className="flex flex-wrap items-center justify-between gap-2">
                <span>{fill(t("exportJob.part", locale), { n: String(p.n), mb: megabytes(p.bytes) })}</span>
                <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void download(p.n)}>
                  {t("exportJob.download", locale)}
                </Button>
              </li>
            ))}
          </ul>
          <DownloadLink href={`/api/farm/export/jobs/${job.id}/download?manifest=1`} labels={labels} className="mt-2 inline-block font-medium underline">
            {t("exportJob.manifest", locale)}
          </DownloadLink>
          {job.files_missing > 0 ? (
            <div className="mt-3">
              <p className="text-status-due">{fill(t("exportJob.missing", locale), { n: String(job.files_missing) })}</p>
              <Button type="button" variant="secondary" size="sm" className="mt-1" disabled={busy} onClick={() => void retry()}>
                {t("exportJob.retry", locale)}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {job?.status === "failed" ? <p className="text-status-overdue">{t("exportJob.failed", locale)}</p> : null}
      {error ? <p role="alert" className="text-status-overdue">{error}</p> : null}

      {loaded && !running ? (
        <div>
          <Button type="button" variant={ready ? "secondary" : "primary"} disabled={busy} onClick={() => void start()}>
            {t(ready ? "exportJob.again" : "exportJob.start", locale)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
