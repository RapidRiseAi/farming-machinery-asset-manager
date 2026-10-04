"use client";
import { useActionState, useId } from "react";
import { configureConnection } from "./actions";
import { t, type Lang } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
export type Connection = {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  quote_reference: string | null;
};
export function ConnectionForm({
  farm,
  connection,
  locale,
}: {
  farm: string;
  connection?: Connection;
  locale: Lang;
}) {
  const [state, action] = useActionState(configureConnection, {});
  const prefix = useId();
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="farm" value={farm} />
      <input type="hidden" name="id" value={connection?.id ?? state.id ?? ""} />
      <Field
        label={t("driving.connectionName", locale)}
        htmlFor={`${prefix}-name`}
      >
        <Input
          id={`${prefix}-name`}
          name="name"
          defaultValue={connection?.name}
          maxLength={120}
          required
        />
      </Field>
      <Field
        label={t("driving.connectionKind", locale)}
        htmlFor={`${prefix}-kind`}
      >
        <Select
          id={`${prefix}-kind`}
          name="kind"
          defaultValue={connection?.kind ?? "tracker"}
        >
          {["tracker", "key_tag", "camera", "engine_sensor", "other"].map(
            (k) => (
              <option value={k} key={k}>
                {t(`driving.kinds.${k}`, locale)}
              </option>
            ),
          )}
        </Select>
      </Field>
      <Field label={t("driving.quote", locale)} htmlFor={`${prefix}-quote`}>
        <Input
          id={`${prefix}-quote`}
          name="quote"
          defaultValue={connection?.quote_reference ?? ""}
          maxLength={200}
        />
      </Field>
      <label className="flex min-h-12 items-center gap-3">
        <input
          type="checkbox"
          name="active"
          defaultChecked={connection?.active ?? false}
        />
        {t("driving.activate", locale)}
      </label>
      {connection && (
        <label className="flex min-h-12 items-center gap-3">
          <input type="checkbox" name="rotate" />
          {t("driving.rotate", locale)}
        </label>
      )}
      <SubmitButton>{t("common.save", locale)}</SubmitButton>
      {state.error && (
        <p role="alert">{t("driving.connectionError", locale)}</p>
      )}
      {state.saved && <p role="status">{t("driving.saved", locale)}</p>}
      {state.token && (
        <div className="rounded-lg border border-sand-200 p-3">
          <p>{t("driving.tokenOnce", locale)}</p>
          <code className="break-all select-all">{state.token}</code>
        </div>
      )}
    </form>
  );
}
