import { getProfile, homePathFor } from "@/lib/auth";
import { unstable_rethrow } from "next/navigation";
import { captureError } from "@/lib/observability";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { QueueRecovery } from "@/components/offline/queue-recovery";
import { PageHeader } from "@/components/ui/page-header";

export default async function QueuePage() {
  // The recovery page is for a bad connection, the very moment a profile read can fail:
  // it still renders rather than the error screen standing between a driver and their
  // unsent work. Unread is not "signed out", so it is passed on as unread (undefined),
  // and the recovery list goes by the browser's own session instead of hiding the
  // person's captures as another account's.
  const read = await getProfile().then(
    (profile) => ({ profile, unread: false }),
    (error) => {
      unstable_rethrow(error);
      captureError(error, { where: "offline-queue:profile" });
      return { profile: null, unread: true };
    },
  );
  const { profile } = read;
  const locale = profile?.lang ?? (await deviceLocale());
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
      <QueueRecovery userId={read.unread ? undefined : profile?.active ? profile.id : null} locale={locale} />
    </main>
  );
}
