import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { MachineFields, type OperatorOption } from "@/components/machine-fields";
import { MachinePhotoNew } from "@/components/machine-photo-new";
import { Card } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
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
  const locale = profile.lang;
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
        <ChevronLeftIcon className="text-base" />
        {t("machines.title", locale)}
      </Link>
      <h1 className="text-2xl font-bold tracking-tight text-ink">{t("machines.add", locale)}</h1>
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      {/* The ceiling message told the farmer to "add more slots on the billing screen" and
          then left them to go and find it. The one person who can act on this is the owner
          — a manager sees the same wall and cannot buy anything — so the button is theirs
          alone and everyone else keeps the sentence without a dead end attached. */}
      {sp.error === "vehicle-limit-reached" && profile.role === "owner" ? (
        // `manage` opens the disclosure the slots form lives behind on /billing; the
        // fragment alone would scroll to a form inside a closed box.
        <Link href="/billing?manage=slots#slots" className={buttonVariants({ variant: "primary" })}>
          {t("machines.limitAddSlots", locale)}
        </Link>
      ) : null}
      <Card>
        <form action={createMachine} className="flex flex-col gap-5">
          <MachineFields locale={locale} operators={operators} />
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-sand-400">{t("machines.primaryPhoto", locale)}</h3>
            <MachinePhotoNew locale={locale} />
          </div>
          <SubmitButton variant="primary" fullWidth>
            {t("common.save", locale)}
          </SubmitButton>
        </form>
      </Card>
    </div>
  );
}
