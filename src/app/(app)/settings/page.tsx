import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { updateSettings } from "./actions";

type Settings = Record<string, unknown>;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "owner" && profile.role !== "manager") redirect("/dashboard");
  const sp = await searchParams;

  const supabase = await createClient();
  const { data } = await supabase.from("farms").select("name, settings").eq("id", profile.farm_id ?? "").maybeSingle();
  const farm = data as { name: string; settings: Settings } | null;
  const s = (farm?.settings ?? {}) as Record<string, unknown>;
  const n = (k: string, d: number) => (typeof s[k] === "number" ? (s[k] as number) : d);
  const b = (k: string) => s[k] === true;
  const input = "rounded border border-gray-300 p-2";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Settings — {farm?.name}</h1>
      {sp.error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{sp.error}</p> : null}
      {sp.saved ? <p className="rounded bg-green-50 p-2 text-sm text-green-700">Saved.</p> : null}

      <form action={updateSettings} className="flex flex-col gap-3">
        <label className="text-sm">Warn when service due within (hours)
          <input name="due_soon_hours" type="number" defaultValue={n("due_soon_hours", 25)} className={`${input} mt-1 w-full`} />
        </label>
        <label className="text-sm">Warn when service due within (days)
          <input name="due_soon_days" type="number" defaultValue={n("due_soon_days", 14)} className={`${input} mt-1 w-full`} />
        </label>
        <label className="text-sm">Flag reading stale after (days)
          <input name="stale_reading_days" type="number" defaultValue={n("stale_reading_days", 30)} className={`${input} mt-1 w-full`} />
        </label>
        <label className="text-sm">VAT rate (basis points, 1500 = 15%)
          <input name="vat_rate_bps" type="number" defaultValue={n("vat_rate_bps", 1500)} className={`${input} mt-1 w-full`} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="approval_required" defaultChecked={b("approval_required")} /> Require owner approval of job cards
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="cost_visible_to_operators" defaultChecked={b("cost_visible_to_operators")} /> Show costs to operators
        </label>
        <div className="flex gap-2">
          <label className="flex-1 text-sm">Quiet hours start
            <input name="quiet_hours_start" type="number" defaultValue={n("quiet_hours_start", 20)} className={`${input} mt-1 w-full`} />
          </label>
          <label className="flex-1 text-sm">Quiet hours end
            <input name="quiet_hours_end" type="number" defaultValue={n("quiet_hours_end", 5)} className={`${input} mt-1 w-full`} />
          </label>
        </div>
        <label className="text-sm">Default language
          <select name="default_language" defaultValue={(s.default_language as string) ?? "af"} className={`${input} mt-1 w-full`}>
            <option value="af">Afrikaans</option>
            <option value="en">English</option>
          </select>
        </label>
        <button className="self-start rounded-lg bg-status-ok px-4 py-2 font-medium text-white">Save settings</button>
      </form>
    </div>
  );
}
