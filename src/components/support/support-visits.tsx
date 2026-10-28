import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/supabase/must";
import { t, type Lang } from "@/lib/i18n";
import { dateTime } from "@/lib/format";
import { Card, CardTitle } from "@/components/ui/card";

type Visit = {
  id: string;
  started_at: string;
  ended_at: string | null;
  reason: string;
  admin_name: string | null;
  about_case: boolean;
};

/**
 * "Rapid Rise support visits", on the owner's Settings.
 *
 * Founder default (2026-10-28): every time Rapid Rise enters the farm in support mode it
 * gives a reason, and the owner can see when, who, why and for how long. Read through
 * `my_farm_support_visits`, which answers the farm's own owner (and Rapid Rise) and nobody
 * else (20261028100700). Server component: nothing to attach.
 */
export async function SupportVisits({ farmId, locale }: { farmId: string; locale: Lang }) {
  const supabase = await createClient();
  // must: a failed read would tell the owner nobody has been in.
  const data = must(await supabase.rpc("my_farm_support_visits", { p_farm: farmId }), "settings:support-visits");
  const visits = (data as Visit[] | null) ?? [];
  return (
    <Card>
      <CardTitle>{t("support.visitsTitle", locale)}</CardTitle>
      <p className="mt-1 text-sm text-sand-600">{t("support.visitsLead", locale)}</p>
      {visits.length === 0 ? (
        <p className="mt-3 text-sm text-sand-600">{t("support.visitsEmpty", locale)}</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-sand-200 text-sm">
          {visits.map((v) => (
            <li key={v.id} className="flex flex-col gap-0.5 py-2">
              <span className="font-medium text-ink">{v.reason}</span>
              <span className="text-xs text-sand-600">
                {(v.admin_name ?? t("support.authorStaff", locale))} · {dateTime(v.started_at, locale)}
                {v.ended_at
                  ? ` · ${t("support.visitEnded", locale).replace("{when}", dateTime(v.ended_at, locale))}`
                  : ` · ${t("support.visitOngoing", locale)}`}
                {v.about_case ? ` · ${t("support.visitAboutCase", locale)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
