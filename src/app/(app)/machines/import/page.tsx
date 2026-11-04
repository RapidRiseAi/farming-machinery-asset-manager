import { errorMessage } from "@/lib/errors";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { Flash } from "@/components/ui/flash";
import { createClient } from "@/lib/supabase/server";
import { readAll } from "@/lib/supabase/read-all";
import { must } from "@/lib/supabase/must";
import type { ExistingMachines } from "./csv";
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
  // The farm's machines, so the preview marks rows that are already here exactly as the
  // server will refuse them. Names, serials and registrations only.
  const supabase = await createClient();
  const rows = profile.farm_id
    ? (must(await readAll(() => supabase.from("machines").select("id, name, serial_no, reg_no")
        .eq("farm_id", profile.farm_id!).is("deleted_at", null)), "machines-import:existing") as
        { name: string; serial_no: string | null; reg_no: string | null }[] | null) ?? []
    : [];
  const existing: ExistingMachines = {
    names: rows.map((r) => r.name),
    serials: rows.map((r) => r.serial_no).filter((v): v is string => !!v),
    regs: rows.map((r) => r.reg_no).filter((v): v is string => !!v),
  };

  return (
    <PageContainer>
      <PageHeader
        title={t("machines.importTitle", locale)}
        back={{ href: "/machines", label: t("nav.machines", locale) }}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <ImportClient locale={locale} existing={existing} />
    </PageContainer>
  );
}
