import type { ReactNode } from "react";

/**
 * One option in a short list of choices inside a dialog (a language, a wording, a start
 * page): a real radio, 48px tall on a phone, with an optional example line under it.
 */
export function ChoiceRadio({
  name,
  value,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex min-h-[48px] cursor-pointer items-start gap-3 rounded-lg border border-sand-200 px-3 py-2.5 hover:bg-surface-sunken sm:min-h-[40px]">
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="focus-ring mt-0.5 h-5 w-5 shrink-0 accent-brand-600"
      />
      <span className="min-w-0">
        <span className="block break-words text-sm font-medium text-sand-900">{label}</span>
        {hint ? <span className="mt-0.5 block break-words text-xs text-sand-500">{hint}</span> : null}
      </span>
    </label>
  );
}
