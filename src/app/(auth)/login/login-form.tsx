"use client";

import { signInWithPassword, signInWithMagicLink } from "./actions";
import { t } from "@/lib/i18n";

export function LoginForm({ error, sent }: { error?: string; sent?: string }) {
  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>
      ) : null}
      {sent ? (
        <p className="rounded bg-green-50 p-2 text-sm text-green-700">
          {t("auth.checkEmail")}
        </p>
      ) : null}

      <form action={signInWithPassword} className="flex flex-col gap-2">
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder={t("auth.email")}
          className="rounded border border-gray-300 p-3"
        />
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder={t("auth.password")}
          className="rounded border border-gray-300 p-3"
        />
        <button className="rounded-lg bg-status-ok px-4 py-3 font-medium text-white">
          {t("auth.signIn")}
        </button>
      </form>

      <form action={signInWithMagicLink} className="flex flex-col gap-2 border-t border-gray-200 pt-4">
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder={t("auth.email")}
          className="rounded border border-gray-300 p-3"
        />
        <button className="rounded-lg border border-gray-300 px-4 py-3">
          {t("auth.magicLink")}
        </button>
      </form>
    </div>
  );
}
