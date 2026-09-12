import Link from "next/link";
import { getProfile } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { QueueRecovery } from "@/components/offline/queue-recovery";

export default async function QueuePage() {
  const profile = await getProfile();
  const locale = profile?.lang ?? "en";
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
    <Link href={profile ? "/dashboard" : "/"} className="focus-ring w-fit rounded underline">{t("ui.back", locale)}</Link>
    <h1 className="text-2xl font-bold">{t("offline.review", locale)}</h1>
    <p className="text-sm text-sand-600">{t("offline.reviewHelp", locale)}</p>
    <QueueRecovery userId={profile?.active ? profile.id : null} locale={locale} />
  </main>;
}
