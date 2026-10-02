import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { ChecklistTemplateBuilder } from "@/components/checklists/template-builder";

export default async function NewChecklistTemplatePage() {
  const profile = await requireRole(["owner", "manager", "mechanic", "rr_admin"]);
  const locale = profile.lang;
  const isGlobal = profile.role === "rr_admin";

  return (
    <PageContainer>
      <PageHeader
        title={t("checklists.newTemplate", locale)}
        lead={t("checklists.builderHint", locale)}
        back={{ href: "/checklists", label: t("checklists.title", locale) }}
      />
      <Card>
        <ChecklistTemplateBuilder mode="create" locale={locale} isGlobal={isGlobal} />
      </Card>
    </PageContainer>
  );
}
