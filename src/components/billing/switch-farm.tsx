import { accessibleFarms, type Profile } from "@/lib/auth";
import { t, type Lang } from "@/lib/i18n";
import { setCurrentFarm } from "@/app/(app)/actions";
import { SubmitButton } from "@/components/ui/submit-button";

/**
 * The way out of a stopped farm's page (paused, closed, not paid yet) for someone who
 * belongs to other farms: one button per other farm, which makes it the farm in use and
 * goes home. Without it, a member whose chosen farm stopped had no screen that could change
 * the choice, and a redirect loop or a dead end was all that was left.
 */
export async function SwitchFarm({ profile, current, locale }: { profile: Profile; current: string; locale: Lang }) {
  const farms = (await accessibleFarms(profile)).filter((f) => f.id !== current);
  if (farms.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-sand-200 p-3">
      <p className="text-sm text-sand-700">{t("gate.otherFarms", locale)}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {farms.map((f) => (
          <form key={f.id} action={setCurrentFarm}>
            <input type="hidden" name="farm_id" value={f.id} />
            <input type="hidden" name="next" value="/home" />
            <SubmitButton look="plain" className="min-h-11 rounded-lg border border-sand-300 px-3 text-sm font-medium text-brand-ink">
              {t("gate.useFarm", locale).replace("{farm}", f.name)}
            </SubmitButton>
          </form>
        ))}
      </div>
    </div>
  );
}
