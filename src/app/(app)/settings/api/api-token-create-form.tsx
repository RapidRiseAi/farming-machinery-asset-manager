"use client";

import { useActionState } from "react";
import { CopyField } from "@/app/(app)/partners/copy-field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import {
  createApiToken,
  type CreateApiTokenState,
} from "./actions";

const EMPTY_API_TOKEN_STATE: CreateApiTokenState = {
  token: null,
  prefix: null,
  error: null,
};

export function ApiTokenCreateForm({ locale, minExpiry }: { locale: Lang; minExpiry: string }) {
  const [state, action] = useActionState(createApiToken, EMPTY_API_TOKEN_STATE);
  const error = state.error ? t(`apiTokens.error.${state.error}`, locale) : undefined;

  return (
    <div className="flex flex-col gap-4">
      {state.token ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4" role="status">
          <p className="font-semibold text-amber-950">{t("apiTokens.copyNow", locale)}</p>
          <p className="mt-1 text-sm text-amber-900">{t("apiTokens.copyNowHint", locale)}</p>
          <div className="mt-3">
            <CopyField
              value={state.token}
              copyLabel={t("apiTokens.copy", locale)}
              copiedLabel={t("apiTokens.copied", locale)}
            />
          </div>
        </div>
      ) : null}

      <Flash tone="error" message={error} />
      <form action={action} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium text-sand-800 sm:col-span-2">
          {t("apiTokens.name", locale)}
          <Input name="name" required minLength={3} maxLength={80} autoComplete="off" />
          <span className="font-normal text-sand-500">{t("apiTokens.nameHint", locale)}</span>
        </label>

        <label className="flex items-start gap-2.5 rounded-lg border border-sand-200 p-3 text-sm text-sand-800">
          <input
            type="checkbox"
            name="scope_read"
            defaultChecked
            className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600"
          />
          <span>
            <strong className="block">{t("apiTokens.scopeRead", locale)}</strong>
            <span className="text-sand-500">{t("apiTokens.scopeReadHint", locale)}</span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 rounded-lg border border-sand-200 p-3 text-sm text-sand-800">
          <input
            type="checkbox"
            name="scope_write_readings"
            className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600"
          />
          <span>
            <strong className="block">{t("apiTokens.scopeWrite", locale)}</strong>
            <span className="text-sand-500">{t("apiTokens.scopeWriteHint", locale)}</span>
          </span>
        </label>

        <label className="flex flex-col gap-1.5 text-sm font-medium text-sand-800 sm:col-span-2">
          {t("apiTokens.expiry", locale)}
          <Input type="date" name="expires_on" min={minExpiry} />
          <span className="font-normal text-sand-500">{t("apiTokens.expiryHint", locale)}</span>
        </label>

        <div className="sm:col-span-2">
          <SubmitButton pendingText={t("apiTokens.creating", locale)}>
            {t("apiTokens.create", locale)}
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
