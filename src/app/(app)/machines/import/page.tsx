import { errorMessage } from "@/lib/errors";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { Flash } from "@/components/ui/flash";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { ImportClient } from "./import-client";

export default async function ImportMachinesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await requireRole(["owner", "manager"]);
  const locale = profile.lang;
  const sp = await searchParams;

  return (
    <PageContainer>
      <PageHeader
        title={t("machines.importTitle", locale)}
        back={{ href: "/machines", label: t("nav.machines", locale) }}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <ImportClient locale={locale} />
    </PageContainer>
  );
}
