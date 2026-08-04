import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, homePathFor } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { CheckIcon } from "@/components/ui/icons";
import { acknowledgeQrLabels } from "./actions";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const sp = await searchParams;
  const profile = await requireProfile();
  if (profile.role !== "owner" && profile.role !== "manager") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.language;
  const supabase = await createClient();

  const [machinesRes, planRes, usersRes, farmRes] = await Promise.all([
    supabase.from("machines").select("id", { count: "exact", head: true }).is("deleted_at", null),
    supabase.from("service_plan_lines").select("id", { count: "exact", head: true }).is("deleted_at", null),
    supabase.from("users").select("id", { count: "exact", head: true }).eq("active", true),
    profile.farm_id
      ? supabase.from("farms").select("settings").eq("id", profile.farm_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const machines = machinesRes.count ?? 0;
  const plans = planRes.count ?? 0;
  const users = usersRes.count ?? 0;
  // Step 3 has its own condition — it used to reuse `machines > 0`, so adding one
  // machine ticked "put QR stickers on them" too (audit bug 1).
  const settings = (farmRes.data as { settings?: Record<string, unknown> } | null)?.settings ?? {};
  const qrLabelsDone = !!settings.qr_labels_printed_at;

  const steps = [
    { key: "step1", done: machines > 0, cta: "/machines/new", ctaKey: "onboarding.step1Cta", alt: "/machines/import", altKey: "onboarding.step1Alt" },
    { key: "step2", done: plans > 0, cta: "/machines", ctaKey: "onboarding.step2Cta" },
    { key: "step3", done: qrLabelsDone, cta: "/machines", ctaKey: "onboarding.step3Cta", ack: true },
    { key: "step4", done: users > 1, cta: "/team", ctaKey: "onboarding.step4Cta" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const pct = Math.round((doneCount / steps.length) * 100);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("onboarding.title", locale)}</h1>
        <p className="mt-1 text-sand-500">{t("onboarding.subtitle", locale)}</p>
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash
        tone="success"
        message={sp.saved === "qr_labels" ? t("ui.qrLabelsMarked", locale) : undefined}
      />

      <div>
        <div className="mb-1.5 flex justify-between text-sm">
          <span className="font-medium text-sand-700">
            {doneCount === steps.length ? t("onboarding.allDone", locale) : t("onboarding.progress", locale).replace("{done}", String(doneCount)).replace("{total}", String(steps.length))}
          </span>
          <span className="tabular-nums text-sand-400">{pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-sand-100">
          <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <li key={s.key}>
            <Card className={s.done ? "opacity-80" : undefined}>
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${s.done ? "bg-status-ok text-white" : "bg-sand-100 text-sand-500"}`}>
                  {s.done ? <CheckIcon className="text-[1.1rem]" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-semibold text-sand-900">{t(`onboarding.${s.key}Title`, locale)}</h2>
                    <span className={`shrink-0 text-xs font-medium ${s.done ? "text-status-ok" : "text-sand-400"}`}>
                      {s.done ? t("onboarding.done", locale) : t("onboarding.todo", locale)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-sand-500">{t(`onboarding.${s.key}Desc`, locale)}</p>
                  {s.ack && !s.done ? (
                    <p className="mt-2 text-sm text-sand-500">{t("onboarding.step3Hint", locale)}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href={s.cta} className={buttonVariants({ variant: s.done ? "secondary" : "primary", size: "sm" })}>
                      {t(s.ctaKey, locale)}
                    </Link>
                    {s.alt ? (
                      <Link href={s.alt} className={buttonVariants({ variant: "ghost", size: "sm" })}>{t(s.altKey!, locale)}</Link>
                    ) : null}
                    {s.ack ? (
                      <form action={acknowledgeQrLabels}>
                        {s.done ? <input type="hidden" name="undo" value="1" /> : null}
                        <SubmitButton variant="ghost" size="sm">
                          {s.done ? t("onboarding.step3Undo", locale) : t("onboarding.step3Ack", locale)}
                        </SubmitButton>
                      </form>
                    ) : null}
                  </div>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ol>

      <Link href="/dashboard" className="text-center text-sm text-sand-500">{t("nav.dashboard", locale)} →</Link>
    </div>
  );
}
