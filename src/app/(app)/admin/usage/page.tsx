import { requireRole } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { num } from "@/lib/format";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { must } from "@/lib/supabase/must";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { monthStart, usageCharge, type UsageRates } from "@/lib/usage-billing";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { raiseUsageInvoice, saveUsageRates } from "./actions";

/**
 * WhatsApp messages and storage per business, at cost plus the markup. Internal, English-only
 * like the rest of the RR console. Messages are counted for the month chosen; storage is what
 * each business holds now.
 */
export const dynamic = "force-dynamic";

type Usage = { farm_id: string; whatsapp_sent: number; storage_bytes: number };

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; error?: string; saved?: string }>;
}) {
  const profile = await requireRole(["rr_admin"]);
  const sp = await searchParams;
  const month = monthStart(sp.month);
  const supabase = await createClient();
  const rates = must(
    await supabase.from("usage_rates").select("whatsapp_message_cents, storage_gb_month_cents, markup_bps").maybeSingle(),
    "admin-usage:rates",
  ) as UsageRates | null;
  const svc = createServiceClient();
  const usage = (must(await svc.rpc("usage_for_month", { p_month: month }), "admin-usage:usage") ?? []) as Usage[];
  const farms = (must(await supabase.from("farms").select("id, name").limit(2000), "admin-usage:farms") ?? []) as { id: string; name: string }[];
  const nameOf = new Map(farms.map((f) => [f.id, f.name]));
  const priced = rates?.whatsapp_message_cents != null || rates?.storage_gb_month_cents != null;

  return (
    <PageContainer size="wide">
      <PageHeader title="Usage" lead="Messages and storage per business, passed on at cost plus the markup." />
      <Flash tone="error" message={errorMessage(sp.error, profile.lang)} />
      <Flash tone="success" message={sp.saved === "invoice" ? "Usage invoice raised." : sp.saved ? t("ui.saved", profile.lang) : undefined} />

      <Card>
        <CardHeader><CardTitle as="h3">What each costs Rapid Rise</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-sand-600">
          Read these from the provider&apos;s own account. Until a cost is set, nothing is charged for it.
        </p>
        <form action={saveUsageRates} className="grid gap-3 sm:grid-cols-3">
          <Field label="One WhatsApp message (R)" htmlFor="u_wa">
            <Input id="u_wa" name="whatsapp_message" inputMode="decimal" defaultValue={rates?.whatsapp_message_cents != null ? String(rates.whatsapp_message_cents / 100) : ""} />
          </Field>
          <Field label="One GB stored for a month (R)" htmlFor="u_gb">
            <Input id="u_gb" name="storage_gb_month" inputMode="decimal" defaultValue={rates?.storage_gb_month_cents != null ? String(rates.storage_gb_month_cents / 100) : ""} />
          </Field>
          <Field label="Markup (%)" htmlFor="u_markup">
            <Input id="u_markup" name="markup_percent" inputMode="numeric" defaultValue={String((rates?.markup_bps ?? 3000) / 100)} />
          </Field>
          <div className="sm:col-span-3"><SubmitButton>Save</SubmitButton></div>
        </form>
      </Card>

      <form className="flex flex-wrap items-end gap-3">
        <Field label="Month" htmlFor="u_month">
          <Input id="u_month" name="month" type="month" defaultValue={month.slice(0, 7)} />
        </Field>
        <SubmitButton variant="secondary">Show</SubmitButton>
      </form>

      {usage.length === 0 ? (
        <EmptyState title="No usage this month" />
      ) : (
        <Card flush>
          <div className="overflow-x-auto">
            <Table>
              <Thead>
                <Tr>
                  <Th>Business</Th>
                  <Th>Messages sent</Th>
                  <Th>Stored now</Th>
                  <Th>To charge</Th>
                  <Th><span className="sr-only">Invoice</span></Th>
                </Tr>
              </Thead>
              <Tbody>
                {usage.map((u) => {
                  const charge = rates ? usageCharge(u, rates) : null;
                  return (
                    <Tr key={u.farm_id}>
                      <Td>{nameOf.get(u.farm_id) ?? u.farm_id}</Td>
                      <Td className="tnum">{num(Number(u.whatsapp_sent))}</Td>
                      <Td className="tnum">{charge ? `${num(charge.gigabytes)} GB` : "-"}</Td>
                      <Td className="tnum">{charge && priced ? rands(charge.totalCents) : "Set the costs first"}</Td>
                      <Td className="text-right">
                        {charge && charge.totalCents > 0 ? (
                          <form action={raiseUsageInvoice}>
                            <RequestIdInput action="admin-usage:invoice" />
                            <input type="hidden" name="farm_id" value={u.farm_id} />
                            <input type="hidden" name="month" value={month} />
                            <SubmitButton variant="secondary" size="sm">Raise invoice</SubmitButton>
                          </form>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </div>
        </Card>
      )}
    </PageContainer>
  );
}
