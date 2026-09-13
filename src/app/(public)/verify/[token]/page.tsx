import Link from "next/link";

import { APP_NAME } from "@/lib/env";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { createServiceClient } from "@/lib/supabase/service";
import { hashToken, VERIFY_MAX_AGE_HOURS } from "@/lib/email/verify";
import { MachinesIcon } from "@/components/ui/icons";

/**
 * The link in the verification email.
 *
 * ── Why it is public and service-role ────────────────────────────────────────
 * The person clicking it is frequently NOT signed in — they are in their mail app, quite
 * possibly on a different device from the one they signed up on. There is no session for
 * RLS to scope by, so the token IS the authorisation: it is matched by hash, it is single
 * use (the hash is cleared), and it expires. That is why `app.verify_email_token` is
 * service-role only and takes a hash rather than a user id — nothing here trusts a
 * parameter to say who somebody is.
 *
 * ── Zero anon DB access is not violated ──────────────────────────────────────
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
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-3">
        <MachinesIcon className="size-8 text-brand-ink" aria-hidden="true" />
        <span className="text-xl font-semibold text-brand-ink">{APP_NAME}</span>
      </div>

      <div className="rounded-2xl border border-sand-300 bg-surface p-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{heading}</h1>
        <p className="mt-2 text-sand-700">{body}</p>

        <Link
          href={good ? "/home" : "/account"}
          className="mt-6 flex min-h-12 w-full items-center justify-center rounded-lg bg-brand-500 px-4 text-sm font-semibold text-white sm:min-h-11"
        >
          {t(good ? "verify.continue" : "verify.getAnother", locale)}
        </Link>
      </div>
    </main>
  );
}
