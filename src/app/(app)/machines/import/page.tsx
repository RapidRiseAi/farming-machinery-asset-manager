import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { Flash } from "@/components/ui/flash";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { ImportClient } from "./import-client";

export default async function ImportMachinesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await requireRole(["owner", "manager"]);
  const locale = profile.language;
  const sp = await searchParams;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Link href="/machines" className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-sm text-sand-500">
        <ChevronLeftIcon className="text-[1rem]" />
        {t("machines.title", locale)}
      </Link>
      <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("machines.importTitle", locale)}</h1>
      <Flash tone="error" message={sp.error} />
      <ImportClient locale={locale} />
    </div>
  );
}
