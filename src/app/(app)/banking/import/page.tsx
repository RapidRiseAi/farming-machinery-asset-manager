import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { Flash } from "@/components/ui/flash";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { BankImportClient } from "@/components/banking/import-client";

export const dynamic = "force-dynamic";

/**
 * Load a bank statement (G15).
 *
 * Its own screen rather than a panel on `/banking`, for the same reason the machines
 * importer has one: the mapping step needs room, and it is a thing a partner does once a
 * week at most, while the reconciling screen is the one they open every day.
 */
export default async function BankImportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/documents");
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  // Import failures come back as codes so they can be said in the partner's own language.
  // A raw `nothing_valid` on screen is the same defect as the CSV importer's
  // "name_required, Preview", and it is not the reader's job to know our error codes.
  const known = new Set(["empty", "missing_date", "missing_amount", "nothing_valid", "too_many"]);

  return (
    <PageContainer>
      <PageHeader
        title={t("bank.importTitle", locale)}
        lead={t("bank.importLead", locale)}
        back={{ href: "/banking", label: t("bank.title", locale) }}
      />

      <Flash
        tone="error"
        message={sp.error ? (known.has(sp.error) ? t(`bank.err.${sp.error}`, locale) : sp.error) : undefined}
      />

      <BankImportClient locale={locale} />
    </PageContainer>
  );
}
