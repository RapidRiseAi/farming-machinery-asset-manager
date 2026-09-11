import { redirect } from "next/navigation";

import { APP_NAME } from "@/lib/env";
import { t } from "@/lib/i18n";
import { requireProfile } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { farmBillingGate } from "@/lib/billing/service";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Flash } from "@/components/ui/flash";
import { MachinesIcon } from "@/components/ui/icons";
import { signOut } from "@/app/(app)/actions";
import { reopenFarm } from "./actions";

/**
 * The screen a farm sees once it has lapsed.
 *
 * ── Why there is a screen here at all ────────────────────────────────────────
 * Until 20260911180000 there was no such thing as a closed farm: the gate blocked only a
 * sign-up that had never paid, so cancelling, or failing every retry and sitting on the
 * downgrade plan, both ended in permanent free use. Closing the door needs somewhere for
 * the person to land that answers the three questions they will actually have — what
 * happened, how do I come back, and what about my records.
 *
 * ── Why not a read-only mode ─────────────────────────────────────────────────
 * Letting them browse but not write means every one of the product's server actions has to
 * check, and one missed action is a write path into an account nobody is paying for. F7
 * exists in this codebase because UI-only enforcement is not enforcement. One screen can be
 * proved correct; two hundred guards cannot. So the promise "nothing is deleted" is kept by
 * the export below rather than by a half-applied read-only mode.
 *
 * ── Why it lives in `(auth)` ─────────────────────────────────────────────────
 * Same reason as `/activate`: `(app)/layout.tsx` is where the gate runs, so a page inside
 * it would bounce to itself for ever.
 */
export default async function ClosedPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const profile = await requireProfile();
  const locale = profile.lang;

  if (!profile.farm_id) redirect("/home");

  const supabase = await createClient();
  const gate = await farmBillingGate(supabase, profile.farm_id);
  // Open again — paid, reopened, or un-suspended. Nothing to see here.
  if (gate !== "closed") redirect("/home");

  // Read through the CALLER's client, so what is shown is what they are allowed to know.
  // The SELECT policy on the billing tables is `app.is_farm_billing_admin`, so an operator
  // gets nothing back and reads the general sentence rather than their employer's
  // commercial position — which is the right outcome, not a limitation to work around.
  const { data } = await supabase
    .from("billing_subscriptions")
    .select("status, ended_on, downgraded_at, plan")
    .eq("farm_id", profile.farm_id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sub = data as
    | { status: string; ended_on: string | null; downgraded_at: string | null; plan: string }
    | null;

  const canReopen = profile.role === "owner" || profile.role === "manager";
  // Three ways to be closed and they are not the same conversation. A farm Rapid Rise
  // suspended must not be told "your payments stopped", and a farm that cancelled on
  // purpose should not be told it lapsed.
  const reason =
    sub?.status === "cancelled"
      ? "cancelled"
      : sub?.status === "downgraded"
        ? "unpaid"
        : "suspended";
  const since = sub?.ended_on ?? sub?.downgraded_at ?? null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-3">
        <MachinesIcon className="size-8 text-brand-ink" aria-hidden="true" />
        <span className="text-xl font-semibold text-brand-ink">{APP_NAME}</span>
      </div>

      <div className="rounded-2xl border border-sand-300 bg-surface-1 p-6">
        <h1 className="text-2xl font-semibold">{t("closed.title", locale)}</h1>
        <p className="mt-2 text-sand-700">{t(`closed.reason.${reason}`, locale)}</p>
        {since ? (
          <p className="mt-1 text-sm text-sand-600">
            {t("closed.since", locale).replace("{date}", shortDate(since, locale))}
          </p>
        ) : null}

        <p className="mt-4 rounded-lg bg-brand-50 p-3 text-sm text-sand-800">
          {t("closed.dataSafe", locale)}
        </p>

        {sp.error ? (
          <div className="mt-4">
            <Flash tone="error" message={errorMessage(sp.error, locale)} />
          </div>
        ) : null}

        {canReopen && reason !== "suspended" ? (
          <form action={reopenFarm} className="mt-6">
            <Button type="submit" className="w-full">
              {t("closed.reopen", locale)}
            </Button>
          </form>
        ) : null}

        {/* Their records, on the way out. This is what makes closing the door defensible:
            the product has promised since the downgrade shipped that nothing is deleted,
            and a promise you cannot act on is not one. A plain link, not a form — the
            route streams a file and nothing is being changed. */}
        <a
          href="/api/farm/export"
          className="mt-3 flex min-h-12 w-full items-center justify-center rounded-lg border border-sand-300 px-4 text-sm font-medium sm:min-h-11"
        >
          {t("closed.download", locale)}
        </a>

        <p className="mt-4 text-xs text-sand-700">
          {t("closed.help", locale).replace("{email}", "team@rapidriseai.com")}
        </p>
      </div>

      {/* The same dead end /activate had: this screen catches every app route, so without
          a way out somebody on the wrong account is stuck on it. */}
      <form action={signOut} className="text-center">
        <p className="text-xs text-sand-600">
          {t("gate.signedInAs", locale).replace("{email}", profile.email ?? "—")}
        </p>
        <button type="submit" className="mt-1 min-h-12 text-sm font-medium text-brand-ink underline sm:min-h-11">
          {t("gate.signOut", locale)}
        </button>
      </form>
    </main>
  );
}
