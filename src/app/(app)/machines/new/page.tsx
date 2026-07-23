import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { MachineFields, type OperatorOption } from "@/components/machine-fields";
import { Card } from "@/components/ui/card";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { createMachine } from "../actions";

export default async function NewMachinePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await requireRole(["owner", "manager"]);
  const locale = profile.language;
  const sp = await searchParams;

  const supabase = await createClient();
  const { data: opData } = await supabase
    .from("users")
    .select("id, name")
    .eq("active", true)
    .is("deleted_at", null)
    .order("name");
  const operators = (opData as OperatorOption[] | null) ?? [];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link href="/machines" className="focus-ring inline-flex w-fit items-center gap-1 rounded-md text-sm text-sand-500">
        <ChevronLeftIcon className="text-[1rem]" />
        {t("machines.title", locale)}
      </Link>
      <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("machines.add", locale)}</h1>
      <Flash tone="error" message={sp.error} />
      <Card>
        <form action={createMachine} className="flex flex-col gap-5">
          <MachineFields locale={locale} operators={operators} />
          <SubmitButton variant="primary" fullWidth>
            {t("common.save", locale)}
          </SubmitButton>
        </form>
      </Card>
    </div>
  );
}
