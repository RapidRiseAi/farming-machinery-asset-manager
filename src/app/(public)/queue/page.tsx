import { getProfile, homePathFor } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { QueueRecovery } from "@/components/offline/queue-recovery";
import { PageHeader } from "@/components/ui/page-header";

export default async function QueuePage() {
  const profile = await getProfile();
  const locale = profile?.lang ?? "en";
  // Back to the person's OWN home: a driver's is /driver, a partner's /contractor. This
  // used to send everyone signed in to /dashboard, which most roles cannot open.
  const home = profile ? homePathFor(profile.role) : "/";
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title={t("offline.review", locale)}
        lead={t("offline.reviewHelp", locale)}
        back={{ href: home, label: t("offline.backHome", locale) }}
      />
      <QueueRecovery userId={profile?.active ? profile.id : null} locale={locale} />
    </main>
  );
}
