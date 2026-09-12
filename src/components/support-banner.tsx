import { t, type Locale, type Lang } from "@/lib/i18n";
import { SubmitButton } from "@/components/ui/submit-button";
import { WarningIcon } from "@/components/ui/icons";
import { exitSupportMode } from "@/app/(app)/admin/farms/[id]/actions";

/**
 * Support mode, made visible.
 *
 * The whole point of the S10 fix: an admin looking at a customer's data must be able to
 * see that they are, and get out in one tap from wherever they got to. Rendered in the
 * app shell above everything, and only when the farm-context cookie is actually set —
 * so it can never claim a mode that isn't real, which was the original defect in
 * reverse.
 */
export function SupportBanner({ farmName, locale }: { farmName: string; locale: Lang }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-callout-warn-edge bg-callout-warn-bg px-4 py-2.5"
    >
      <p className="flex min-w-0 items-center gap-2 text-sm text-callout-warn-ink">
        <WarningIcon className="shrink-0 text-lg" />
        <span className="min-w-0">
          <span className="font-semibold">{t("admin.supportModeTitle", locale)}</span>{" "}
          <span className="text-callout-warn-ink">
            {t("admin.supportModeBody", locale).replace("{farm}", farmName)}
          </span>
        </span>
      </p>
      <form action={exitSupportMode} className="shrink-0">
        <SubmitButton variant="secondary" size="sm">
          {t("admin.supportModeExit", locale)}
        </SubmitButton>
      </form>
    </div>
  );
}
