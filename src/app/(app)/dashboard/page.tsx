import { requireProfile } from "@/lib/auth";
import { t } from "@/lib/i18n";

export default async function DashboardPage() {
  const profile = await requireProfile();
  return (
    <div>
      <h1 className="text-xl font-bold">{t("nav.dashboard", profile.language)}</h1>
      <p className="mt-2 text-gray-600">
        {profile.name} — {profile.role}
      </p>
      <p className="mt-4 text-sm text-gray-400">
        The farm dashboard (service board, open faults, spend) lands in Week 3.
      </p>
    </div>
  );
}
