import Link from "next/link";

import { checkEntitlement, requireRole } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { num, shortDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { mustAll } from "@/lib/supabase/must";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Stat, StatGrid } from "@/components/ui/stat";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { importStatement, markFillChecked } from "./actions";

/** A fuel card statement, checked against the fleet. Owners and managers only. */
export const dynamic = "force-dynamic";

type Fill = {
  id: string;
  occurred_at: string;
  card_ref: string;
  vehicle_ref: string | null;
  machine_id: string | null;
  driver_ref: string | null;
  merchant: string | null;
  litres: number;
  amount_cents: number;
  flags: string[];
  checked_at: string | null;
};

export default async function FuelCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; added?: string; skipped?: string }>;
}) {
  const profile = await requireRole(["owner", "manager"]);
  const sp = await searchParams;
  const locale = profile.lang;
  const farmId = profile.farm_id ?? "";

  const gate = await checkEntitlement("fuel");
  if (!gate.allowed) {
    return (
      <PageContainer>
        <PageHeader title={t("fuelCards.title", locale)} />
        <UpgradeNotice feature="fuel" requiredPlan={gate.requiredPlan} currentPlan={gate.plan} locale={locale} />
      </PageContainer>
    );
  }

  const supabase = await createClient();
  const results = await Promise.all([
    supabase
      .from("fuel_card_transactions")
      .select("id, occurred_at, card_ref, vehicle_ref, machine_id, driver_ref, merchant, litres, amount_cents, flags, checked_at")
      .eq("farm_id", farmId)
      .order("occurred_at", { ascending: false })
      .limit(500),
    supabase.from("machines").select("id, name").eq("farm_id", farmId).limit(2000),
  ]);
  mustAll(results, "fuel-cards:page");
  const [{ data: fillData }, { data: machineData }] = results;
  const fills = (fillData ?? []) as Fill[];
  const names = new Map(((machineData ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));

  const toCheck = fills.filter((f) => f.flags.length > 0 && !f.checked_at);
  const spent = fills.reduce((sum, f) => sum + Number(f.amount_cents), 0);
  const added = sp.added != null ? Number.parseInt(sp.added, 10) : null;
  const skipped = sp.skipped != null ? Number.parseInt(sp.skipped, 10) : 0;

  return (
    <PageContainer size="wide">
      <p><Link href="/fuel" className="text-sm underline">{t("fuelCards.back", locale)}</Link></p>
      <PageHeader title={t("fuelCards.title", locale)} lead={t("fuelCards.lead", locale)} />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash
        tone="success"
        message={added != null && Number.isFinite(added)
          ? t("fuelCards.imported", locale).replace("{added}", String(added)).replace("{skipped}", String(Number.isFinite(skipped) ? skipped : 0))
          : undefined}
      />

      <Card>
        <CardHeader><CardTitle as="h3">{t("fuelCards.bringIn", locale)}</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-sand-600">{t("fuelCards.bringInHint", locale)}</p>
        <form action={importStatement} className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <Field label={t("fuelCards.file", locale)} htmlFor="fc_file">
              <Input id="fc_file" name="file" type="file" accept=".csv,text/csv" required />
            </Field>
          </div>
          <SubmitButton>{t("fuelCards.import", locale)}</SubmitButton>
        </form>
      </Card>

      {fills.length === 0 ? (
        <EmptyState title={t("fuelCards.emptyTitle", locale)} hint={t("fuelCards.emptyHint", locale)} />
      ) : (
        <>
          <StatGrid columns={3}>
            <Stat label={t("fuelCards.statFills", locale)} value={num(fills.length)} size="md" />
            <Stat label={t("fuelCards.statSpent", locale)} value={rands(spent)} size="md" />
            <Stat label={t("fuelCards.statCheck", locale)} value={num(toCheck.length)} tone={toCheck.length > 0 ? "overdue" : "default"} size="md" />
          </StatGrid>
          <Card flush>
            <div className="overflow-x-auto">
              <Table>
                <Thead>
                  <Tr>
                    <Th>{t("fuelCards.date", locale)}</Th>
                    <Th>{t("fuelCards.vehicle", locale)}</Th>
                    <Th>{t("fuelCards.litres", locale)}</Th>
                    <Th>{t("fuelCards.amount", locale)}</Th>
                    <Th>{t("fuelCards.where", locale)}</Th>
                    <Th>{t("fuelCards.check", locale)}</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {fills.map((f) => (
                    <Tr key={f.id}>
                      <Td>{shortDate(f.occurred_at, locale)}</Td>
                      <Td>{f.machine_id ? (names.get(f.machine_id) ?? "-") : (f.vehicle_ref ?? "-")}</Td>
                      <Td className="tnum">{num(Number(f.litres))}</Td>
                      <Td className="tnum">{rands(Number(f.amount_cents))}</Td>
                      <Td>{f.merchant ?? "-"}</Td>
                      <Td>
                        {f.flags.length === 0 ? (
                          <Badge tone="ok">{t("fuelCards.fine", locale)}</Badge>
                        ) : (
                          <span className="flex flex-wrap items-center gap-1">
                            {f.flags.map((flag) => (
                              <Badge key={flag} tone={f.checked_at ? "neutral" : "warning"}>{t(`fuelCards.flag.${flag}`, locale)}</Badge>
                            ))}
                            {f.checked_at ? null : (
                              <form action={markFillChecked}>
                                <input type="hidden" name="id" value={f.id} />
                                <SubmitButton variant="ghost" size="sm">{t("fuelCards.markChecked", locale)}</SubmitButton>
                              </form>
                            )}
                          </span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </div>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
