import { t } from "@/lib/i18n";
import { requireProfile } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Flash } from "@/components/ui/flash";
import { TextField } from "@/components/ui/field";
import { PageInfoButton } from "@/components/ui/page-info-button";
import {
  changeMyName,
  changeMyEmail,
  changeMyPassword,
  resendVerification,
} from "./actions";

/**
 * Your own account, as opposed to the farm's settings.
 *
 * Until this existed there was no way for anybody to change their own password or email
 * address anywhere in the product — the only `updateUser` call in the codebase was the
 * admin path on the team screen. With password recovery being the magic link, that made a
 * typo'd address at sign-up a permanent lockout that only Rapid Rise could undo.
 *
 * `email_verified_at` is read here with its own query rather than added to
 * `PROFILE_COLUMNS`: `lib/auth.ts` is mid-rework in a concurrent session, and one extra
 * cheap read on one screen is a better trade than a conflict in the file every page depends
 * on. It is also the only screen that needs it.
 */
const SAVED: Record<string, string> = {
  name: "account.savedName",
  email: "account.savedEmail",
  password: "account.savedPassword",
  verification: "account.savedVerification",
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const sp = await searchParams;
  const profile = await requireProfile();
  const locale = profile.lang;

  const supabase = await createClient();
  const { data } = await supabase
    .from("users")
    .select("email_verified_at")
    .eq("id", profile.id)
    .maybeSingle();
  const verifiedAt = (data as { email_verified_at: string | null } | null)?.email_verified_at ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("account.title", locale)}</h1>
          <p className="mt-1 text-sand-700">{t("account.lead", locale)}</p>
        </div>
        <PageInfoButton infoKey="account" locale={locale} />
      </div>

      {sp.saved && SAVED[sp.saved] ? (
        <Flash tone="success" message={t(SAVED[sp.saved], locale)} />
      ) : null}
      {sp.error ? <Flash tone="error" message={errorMessage(sp.error, locale)} /> : null}

      {/* ── Who you are ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("account.nameTitle", locale)}</CardTitle>
        </CardHeader>
        <form action={changeMyName} className="space-y-4">
          <TextField
            name="name"
            label={t("account.nameLabel", locale)}
            defaultValue={profile.name}
            required
            maxLength={120}
          />
          <Button type="submit">{t("account.save", locale)}</Button>
        </form>
      </Card>

      {/* ── The address everything depends on ────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("account.emailTitle", locale)}</CardTitle>
        </CardHeader>
        <p className="text-sm text-sand-700">{t("account.emailWhy", locale)}</p>

        <div className="mt-3 rounded-lg border border-sand-300 p-3">
          <p className="font-medium">{profile.email ?? "—"}</p>
          {verifiedAt ? (
            <p className="mt-1 text-sm text-status-ok">
              {t("account.verified", locale).replace("{date}", shortDate(verifiedAt, locale))}
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-status-warn">{t("account.unverified", locale)}</p>
              <form action={resendVerification} className="mt-3">
                <Button type="submit" variant="secondary" size="sm">
                  {t("account.resend", locale)}
                </Button>
              </form>
            </>
          )}
        </div>

        <form action={changeMyEmail} className="mt-4 space-y-4 border-t border-sand-200 pt-4">
          <TextField
            name="email"
            type="email"
            label={t("account.newEmailLabel", locale)}
            hint={t("account.newEmailHint", locale)}
            required
          />
          <Button type="submit" variant="secondary">
            {t("account.changeEmail", locale)}
          </Button>
        </form>
      </Card>

      {/* ── The password there was no way to change ──────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("account.passwordTitle", locale)}</CardTitle>
        </CardHeader>
        <p className="text-sm text-sand-700">{t("account.passwordWhy", locale)}</p>
        <form action={changeMyPassword} className="mt-4 space-y-4">
          <TextField
            name="password"
            type="password"
            label={t("account.newPassword", locale)}
            hint={t("account.passwordHint", locale)}
            minLength={8}
            required
            autoComplete="new-password"
          />
          <TextField
            name="password_again"
            type="password"
            label={t("account.newPasswordAgain", locale)}
            minLength={8}
            required
            autoComplete="new-password"
          />
          <Button type="submit">{t("account.changePassword", locale)}</Button>
        </form>
      </Card>
    </div>
  );
}
