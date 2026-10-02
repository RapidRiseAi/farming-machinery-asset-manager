"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CopyField } from "@/app/(app)/partners/copy-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFields, useDialogForm } from "@/components/ui/dialog-form";
import { TextField } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
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

/**
 * The "New credential" dialog's body. Rendered inside a `DialogForm` on /settings/api.
 *
 * It deliberately does NOT use `DialogActions`: that closes the dialog the moment the
 * submit settles, and this action does not redirect, it RETURNS the one-time secret.
 * Closing then would throw away the only copy of it. So the dialog stays open on the
 * secret, and the person closes it with Done once it is stored. Closing unmounts this
 * component (the overlay renders nothing while shut), so reopening starts a clean form
 * and the secret is never shown twice.
 */
export function ApiTokenCreateForm({ locale, minExpiry }: { locale: Lang; minExpiry: string }) {
  const [state, action] = useActionState(createApiToken, EMPTY_API_TOKEN_STATE);
  const { close } = useDialogForm();
  const error = state.error ? t(`apiTokens.error.${state.error}`, locale) : undefined;

  if (state.token) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-gold-300 bg-callout-warn-bg p-4" role="status">
          <p className="font-semibold text-gold-900">{t("apiTokens.copyNow", locale)}</p>
          <p className="mt-1 text-sm text-gold-800">{t("apiTokens.copyNowHint", locale)}</p>
          <div className="mt-3 min-w-0">
            <CopyField
              value={state.token}
              copyLabel={t("apiTokens.copy", locale)}
              copiedLabel={t("apiTokens.copied", locale)}
            />
          </div>
        </div>
        <div className="sticky bottom-0 -mx-5 flex justify-end border-t border-sand-100 bg-surface px-5 py-3">
          <Button type="button" onClick={close}>
            {t("apiTokens.done", locale)}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={action}>
      <Flash tone="error" message={error} className="mb-3" clearParams={false} />
      <DialogFields columns={1}>
        <TextField
          name="name"
          label={t("apiTokens.name", locale)}
          hint={t("apiTokens.nameHint", locale)}
          required
          minLength={3}
          maxLength={80}
          autoComplete="off"
          error={state.error === "name" ? error : undefined}
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium text-sand-800">
            {t("apiTokens.scopesLabel", locale)}
          </legend>
          <Checkbox
            id="api-token-scope-read"
            name="scope_read"
            defaultChecked
            label={t("apiTokens.scopeRead", locale)}
            hint={t("apiTokens.scopeReadHint", locale)}
          />
          <Checkbox
            id="api-token-scope-write"
            name="scope_write_readings"
            label={t("apiTokens.scopeWrite", locale)}
            hint={t("apiTokens.scopeWriteHint", locale)}
          />
        </fieldset>
        <TextField
          type="date"
          name="expires_on"
          min={minExpiry}
          label={t("apiTokens.expiry", locale)}
          hint={t("apiTokens.expiryHint", locale)}
          error={state.error === "expiry" ? error : undefined}
        />
      </DialogFields>
      <CreateActions locale={locale} onCancel={close} />
    </form>
  );
}

/** Cancel + submit. Inside the form, so `useFormStatus` reports THIS submission. */
function CreateActions({ locale, onCancel }: { locale: Lang; onCancel: () => void }) {
  const { pending } = useFormStatus();
  return (
    <div className="sticky bottom-0 -mx-5 mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-sand-100 bg-surface px-5 py-3">
      <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
        {t("common.cancel", locale)}
      </Button>
      <SubmitButton pendingText={t("apiTokens.creating", locale)}>
        {t("apiTokens.create", locale)}
      </SubmitButton>
    </div>
  );
}
