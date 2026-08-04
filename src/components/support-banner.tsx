import { t, type Locale } from "@/lib/i18n";
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
export function SupportBanner({ farmName, locale }: { farmName: string; locale: Locale }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-300 bg-amber-100 px-4 py-2.5"
    >
      <p className="flex min-w-0 items-center gap-2 text-sm text-amber-950">
        <WarningIcon className="shrink-0 text-[1.15rem]" />
        <span className="min-w-0">
          <span className="font-semibold">{t("admin.supportModeTitle", locale)}</span>{" "}
          <span className="text-amber-900">
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
