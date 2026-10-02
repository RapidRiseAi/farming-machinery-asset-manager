import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { requireRole, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { MachineFields, type OperatorOption } from "@/components/machine-fields";
import { MachinePhotoNew } from "@/components/machine-photo-new";
import { Card } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { createMachine } from "../actions";

/** Sorted distinct non-empty values, for the form's datalist suggestions. */
function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.map((v) => v?.trim() ?? "").filter((v) => v !== ""))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export default async function NewMachinePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await requireRole(["owner", "manager"]);
  const locale = profile.lang;
  const sp = await searchParams;

  const supabase = await createClient();
  const farmId = await currentFarmId(profile);
  let dimQuery = supabase
    .from("machines")
    .select("cost_centre, department, location")
    .is("deleted_at", null);
  if (farmId) dimQuery = dimQuery.eq("farm_id", farmId);
  const [{ data: opData }, { data: dimData }] = await Promise.all([
    supabase.from("users").select("id, name").eq("active", true).is("deleted_at", null).order("name"),
    dimQuery,
  ]);
  const operators = (opData as OperatorOption[] | null) ?? [];
  const dims = (dimData as { cost_centre: string | null; department: string | null; location: string | null }[] | null) ?? [];

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={t("machines.add", locale)}
        lead={t("machines.newLead", locale)}
        back={{ href: "/machines", label: t("nav.machines", locale) }}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      {/* The ceiling message told the farmer to "add more slots on the billing screen" and
          then left them to go and find it. The one person who can act on this is the owner:
          a manager sees the same wall and cannot buy anything, so the button is theirs
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
          {/* The photo leads, because the first-run hint says so ("Take a photo, give it
              the name everyone actually calls it") and because that is how a driver
              recognises the machine on the list. */}
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-sand-900">{t("machines.primaryPhoto", locale)}</h2>
            <MachinePhotoNew locale={locale} />
          </div>
          <MachineFields
            locale={locale}
            operators={operators}
            costCentres={distinct(dims.map((d) => d.cost_centre))}
            departments={distinct(dims.map((d) => d.department))}
            locations={distinct(dims.map((d) => d.location))}
          />
          {/* Save stays in reach on a phone once a section is open, sitting just above
              the tab bar; from lg it is simply the end of the form. */}
          <div className="sticky bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom,0px))] z-10 -mx-4 -mb-4 border-t border-sand-200 bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-5 sm:-mb-5 sm:rounded-b-xl sm:px-5 lg:bottom-0">
            <SubmitButton variant="primary" fullWidth>
              {t("machines.add", locale)}
            </SubmitButton>
          </div>
        </form>
      </Card>
    </PageContainer>
  );
}
