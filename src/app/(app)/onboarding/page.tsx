import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { redirect } from "next/navigation";
import { requireProfile, homePathFor } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t, type Lang } from "@/lib/i18n";
import { setupSteps, type SetupStep } from "@/lib/setup-steps";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
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
  const locale = profile.lang;
  const supabase = await createClient();

  const [machinesRes, planRes, usersRes, farmRes] = await Promise.all([
    supabase.from("machines").select("id", { count: "exact", head: true }).is("deleted_at", null),
    supabase.from("service_plan_lines").select("id", { count: "exact", head: true }).is("deleted_at", null),
    supabase.from("users").select("id", { count: "exact", head: true }).eq("active", true),
    profile.farm_id
      ? supabase.from("farms").select("settings").eq("id", profile.farm_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  // Step 3 has its own condition, it used to reuse `machines > 0`, so adding one
  // machine ticked "put QR stickers on them" too (audit bug 1).
  const settings = (farmRes.data as { settings?: Record<string, unknown> } | null)?.settings ?? {};
  const steps = setupSteps({
    machines: machinesRes.count ?? 0,
    plans: planRes.count ?? 0,
    qrLabelsDone: !!settings.qr_labels_printed_at,
    users: usersRes.count ?? 0,
  });
  const doneCount = steps.filter((s) => s.done).length;
  const pct = Math.round((doneCount / steps.length) * 100);
  // What is left comes first. Done steps used to keep their full cards and buttons, so
  // the one open step started 790px down a phone.
  const open = steps.filter((s) => !s.done);
  const done = steps.filter((s) => s.done);
  const number = (s: SetupStep) => steps.indexOf(s) + 1;

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={t("onboarding.title", locale)}
        lead={t("onboarding.subtitle", locale)}
        infoKey="onboarding"
        locale={locale}
        back={{ href: "/dashboard", label: t("nav.dashboard", locale) }}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash
        tone="success"
        message={sp.saved === "qr_labels" ? t("ui.qrLabelsMarked", locale) : undefined}
      />

      <div>
        <div className="mb-1.5 flex justify-between text-sm">
          <span className="font-medium text-sand-700">
            {doneCount === steps.length ? t("onboarding.allDone", locale) : t("onboarding.progress", locale).replace("{done}", String(doneCount)).replace("{total}", String(steps.length))}
          </span>
          <span className="tabular-nums text-sand-500">{pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-sand-100">
          <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {open.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {open.map((s, i) => (
            <li key={s.key}>
              <Card>
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sand-100 text-sm font-semibold text-sand-600">
                    {number(s)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold text-sand-900">{t(`onboarding.${s.key}Title`, locale)}</h2>
                    <p className="mt-0.5 text-sm text-sand-600">{t(`onboarding.${s.key}Desc`, locale)}</p>
                    {s.ack ? <p className="mt-2 text-sm text-sand-600">{t("onboarding.step3Hint", locale)}</p> : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {/* One filled button on the screen: the next step's. */}
                      <Link href={s.cta} className={buttonVariants({ variant: i === 0 ? "primary" : "secondary" })}>
                        {t(s.ctaKey, locale)}
                      </Link>
                      {s.alt ? (
                        <Link href={s.alt} className={buttonVariants({ variant: "ghost" })}>{t(s.altKey!, locale)}</Link>
                      ) : null}
                      {s.ack ? <AckForm done={false} locale={locale} /> : null}
                    </div>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ol>
      ) : null}

      {done.length > 0 ? (
        <Disclosure
          summary={
            done.length === 1
              ? t("onboarding.oneStepDone", locale)
              : t("onboarding.stepsDone", locale).replace("{n}", String(done.length))
          }
          defaultOpen={open.length === 0}
        >
          <ul className="flex flex-col divide-y divide-sand-100">
            {done.map((s) => (
              <li key={s.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-status-ok text-white">
                    <CheckIcon className="text-base" />
                  </span>
                  <span className="min-w-0 text-sm font-medium text-sand-900">{t(`onboarding.${s.key}Title`, locale)}</span>
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  <Link href={s.cta} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                    {t(s.ctaKey, locale)}
                  </Link>
                  {s.ack ? <AckForm done locale={locale} /> : null}
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </PageContainer>
  );
}

/** Step 3 is ticked by hand, and can be unticked. */
function AckForm({ done, locale }: { done: boolean; locale: Lang }) {
  return (
    <form action={acknowledgeQrLabels}>
      {done ? <input type="hidden" name="undo" value="1" /> : null}
      <SubmitButton variant="ghost" size={done ? "sm" : "md"}>
        {done ? t("onboarding.step3Undo", locale) : t("onboarding.step3Ack", locale)}
      </SubmitButton>
    </form>
  );
}
