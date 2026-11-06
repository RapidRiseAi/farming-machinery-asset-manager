import type { Metadata } from "next";
import Link from "next/link";

import { effectiveFarmRole, getProfile } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { CLOSURE_TOKEN, hashClosureToken } from "@/lib/farm-closure";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { createServiceClient } from "@/lib/supabase/service";
import { PublicShell } from "@/components/public-shell";
import { buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { confirmClosure } from "./actions";

/**
 * Where the closure email lands. Opening it changes nothing, because mail scanners open every
 * link they see: the owner has to be signed in, and type the name of the business.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Close account",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ConfirmClosurePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const profile = await getProfile();
  const locale = profile?.lang ?? (await deviceLocale());

  const svc = createServiceClient();
  const { data: closure } = CLOSURE_TOKEN.test(token)
    ? await svc
        .from("farm_closure_requests")
        .select("farm_id, requested_by, expires_at, farms(name)")
        .eq("token_hash", hashClosureToken(token))
        .maybeSingle()
    : { data: null };

  const live = closure && new Date(closure.expires_at as string) > new Date();
  const farms = closure?.farms as { name: string } | { name: string }[] | null | undefined;
  const businessName = (Array.isArray(farms) ? farms[0]?.name : farms?.name) ?? "";
  const isOwner =
    !!profile && !!closure && closure.requested_by === profile.id
    && (await effectiveFarmRole(closure.farm_id as string, profile)) === "owner";
  const heading = "text-3xl font-bold tracking-tight text-ink";

  let content;
  if (!live) {
    content = (
      <>
        <h1 className={heading}>{t("closure.deadTitle", locale)}</h1>
        <p className="mt-2 text-lg text-ink-muted">{t("closure.deadBody", locale)}</p>
      </>
    );
  } else if (!profile) {
    content = (
      <>
        <h1 className={heading}>{t("closure.signInTitle", locale)}</h1>
        <p className="mt-2 text-lg text-ink-muted">{t("closure.signInBody", locale)}</p>
        <Link
          href={`/login?next=${encodeURIComponent(`/close-account/${token}`)}`}
          className={`mt-6 ${buttonVariants({ variant: "primary", size: "lg" })}`}
        >
          {t("publicNav.signIn", locale)}
        </Link>
      </>
    );
  } else if (!isOwner) {
    content = (
      <>
        <h1 className={heading}>{t("closure.notOwnerTitle", locale)}</h1>
        <p className="mt-2 text-lg text-ink-muted">{t("closure.notOwnerBody", locale)}</p>
      </>
    );
  } else {
    content = (
      <>
        <h1 className={heading}>{t("closure.confirmTitle", locale).replace("{business}", () => businessName)}</h1>
        <p className="mt-2 text-lg text-ink-muted">{t("closure.confirmBody", locale)}</p>
        <Flash tone="error" message={errorMessage(sp.error, locale)} className="mt-5" />
        <form action={confirmClosure} className="mt-6 space-y-5">
          <input type="hidden" name="token" value={token} />
          <Field label={t("closure.typeName", locale).replace("{business}", () => businessName)} htmlFor="close_name">
            <Input id="close_name" name="name" required autoComplete="off" />
          </Field>
          <SubmitButton variant="danger" size="lg" fullWidth pendingText={t("closure.closing", locale)}>
            {t("closure.confirmButton", locale)}
          </SubmitButton>
        </form>
      </>
    );
  }

  return (
    <PublicShell locale={locale} languageSwitch={false}>
      <div className="pt-4 sm:pt-10">{content}</div>
    </PublicShell>
  );
}
