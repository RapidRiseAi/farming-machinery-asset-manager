import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { ChecklistTemplateBuilder } from "@/components/checklists/template-builder";

export default async function NewChecklistTemplatePage() {
  const profile = await requireRole(["owner", "manager", "mechanic", "rr_admin"]);
  const locale = profile.language;
  const isGlobal = profile.role === "rr_admin";

  return (
    <div className="flex flex-col gap-4">
      <Link href="/checklists" className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-sm text-sand-500">
        <ChevronLeftIcon className="text-[1rem]" />
        {t("checklists.title", locale)}
      </Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("checklists.newTemplate", locale)}</h1>
        <p className="mt-0.5 text-sm text-sand-500">{t("checklists.builderHint", locale)}</p>
      </div>
      <Card>
        <ChecklistTemplateBuilder mode="create" locale={locale} isGlobal={isGlobal} />
      </Card>
    </div>
  );
}
