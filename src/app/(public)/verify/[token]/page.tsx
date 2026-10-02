import Link from "next/link";

import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { createServiceClient } from "@/lib/supabase/service";
import { hashToken, VERIFY_MAX_AGE_HOURS } from "@/lib/email/verify";
import { CheckIcon, WarningIcon } from "@/components/ui/icons";
import { buttonVariants } from "@/components/ui/button";
import { PublicShell } from "@/components/public-shell";

/**
 * The link in the verification email.
 *
 * == Why it is public and service-role ========================================
 * The person clicking it is frequently NOT signed in, they are in their mail app, quite
 * possibly on a different device from the one they signed up on. There is no session for
 * RLS to scope by, so the token IS the authorisation: it is matched by hash, it is single
 * use (the hash is cleared), and it expires. That is why `app.verify_email_token` is
 * service-role only and takes a hash rather than a user id, nothing here trusts a
 * parameter to say who somebody is.
 *
 * == Zero anon DB access is not violated ======================================
 * The product's rule is that an anonymous VISITOR never reaches the database with their own
 * credentials. This page does what `/m/[token]` and `/d/[token]` already do: validate an
 * unguessable token server-side and act through the service role. Same shape, same
 * reasoning.
 */
export const dynamic = "force-dynamic";

export default async function VerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const locale = await deviceLocale();

  // An outcome word, not a boolean: "already done" and "that link has expired" are
  // different things to tell somebody who has just clicked, and only one of them needs a
  // way to get another link.
  const service = createServiceClient();
  const { data, error } = await service.rpc("verify_email_token", {
    p_hash: hashToken(token),
    p_max_age_hours: VERIFY_MAX_AGE_HOURS,
  });
  const outcome: string = error ? "invalid" : String(data ?? "invalid");

  const heading = t(`verify.${outcome}.title`, locale);
  const body = t(`verify.${outcome}.body`, locale);
  const good = outcome === "verified" || outcome === "already";

  return (
    <PublicShell locale={locale}>
      <div className="pt-4 sm:pt-10">
        <div className="rounded-2xl border border-sand-200 bg-surface p-6 shadow-xs">
          {/* Shape and word as well as colour: a tick for done, a warning for a link
              that did not work. */}
          <span
            className={`flex size-10 items-center justify-center rounded-full text-xl ${
              good ? "bg-brand-tint text-status-ok" : "bg-callout-warn-bg text-status-due"
            }`}
            aria-hidden="true"
          >
            {good ? <CheckIcon /> : <WarningIcon />}
          </span>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">{heading}</h1>
          <p className="mt-2 text-sand-700">{body}</p>

          <Link
            href={good ? "/home" : "/account"}
            className={`mt-6 ${buttonVariants({ variant: "primary", size: "lg", fullWidth: true })}`}
          >
            {t(good ? "verify.continue" : "verify.getAnother", locale)}
          </Link>
        </div>
      </div>
    </PublicShell>
  );
}
