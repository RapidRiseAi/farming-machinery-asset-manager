import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { WORKSHOP_PLANS, WORKSHOP_PLAN_PRICE_MONTHLY, workshopPlanNameKey } from "@/lib/contractor-plan";
import { setPartnerPlan } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";

/**
 * Which product each partner is on (F14e). Internal, English-only like the rest of the
 * RR console.
 *
 * The price column is DISPLAY ONLY and VAT-inclusive, matching the founder decision that
 * governs the farm-plan display next door. Nothing here charges anyone — the billing
 * adapter is still the no-op — but a console that shows the product without the price
 * leaves "there is a price difference" as folklore rather than a number someone can quote
 * to a partner on the phone.
 */

type Row = {
  id: string;
  name: string;
  trading_name: string | null;
  kind: string;
  plan: string;
  area: string | null;
  created_at: string;
};

export default async function AdminPartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  await requireRole(["rr_admin"]);
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: wData }, { data: linkData }, { data: docData }] = await Promise.all([
    supabase
      .from("workshops")
      .select("id, name, trading_name, kind, plan, area, created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase.from("workshop_links").select("workshop_id, status").is("deleted_at", null),
    supabase.from("partner_documents").select("workshop_id, kind, status").is("deleted_at", null),
  ]);

  const partners = (wData as Row[] | null) ?? [];
  const links = (linkData as { workshop_id: string; status: string }[] | null) ?? [];
  const docs = (docData as { workshop_id: string; kind: string; status: string }[] | null) ?? [];

  const clientsBy = new Map<string, number>();
  for (const l of links) if (l.status === "active") clientsBy.set(l.workshop_id, (clientsBy.get(l.workshop_id) ?? 0) + 1);

  const docsBy = new Map<string, number>();
  for (const d of docs) if (d.status !== "draft") docsBy.set(d.workshop_id, (docsBy.get(d.workshop_id) ?? 0) + 1);

  const onBooks = partners.filter((p) => p.plan === "books").length;
  // A dash where a price has not been set, never a zero: "R0,00/month" reads as a decision
  // somebody made, and this console is where the product gets quoted from.
  const priceOf = (plan: string) =>
    WORKSHOP_PLAN_PRICE_MONTHLY[plan as keyof typeof WORKSHOP_PLAN_PRICE_MONTHLY] ?? null;
  const priceLabel = (plan: string) => {
    const p = priceOf(plan);
    return p == null ? "—" : `${rands(p * 100)}/month`;
  };
  const priced = partners.filter((p) => priceOf(p.plan) != null);
  const indicativeMonthly = priced.reduce((sum, p) => sum + (priceOf(p.plan) ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-sand-900">Partners</h1>
      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? "Saved." : undefined} />

      <Card>
        <CardHeader><CardTitle>At a glance</CardTitle></CardHeader>
        <p className="text-sm text-sand-600">
          {partners.length} partner{partners.length === 1 ? "" : "s"} · {onBooks} on Books ·{" "}
          {priced.length === 0
            ? "the ladder is not priced yet, so there is no subtotal to show."
            : `indicative ${rands(indicativeMonthly * 100)}/month across the ${priced.length} priced (VAT incl., display only — nothing is charged).`}
        </p>
      </Card>

      <Card>
        <CardHeader><CardTitle>Every partner</CardTitle></CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <Thead>
              <Tr>
                <Th>Partner</Th>
                <Th>Trade</Th>
                <Th>Clients</Th>
                <Th>Documents</Th>
                <Th colSpan={3}>Product (indicative price, display only)</Th>
              </Tr>
            </Thead>
            <Tbody>
              {partners.map((p) => (
                <Tr key={p.id}>
                  <Td>
                    <span className="font-medium text-sand-900">{p.trading_name || p.name}</span>
                    {p.area ? <span className="block text-xs text-sand-500">{p.area}</span> : null}
                  </Td>
                  <Td>
                    <Badge tone="neutral">{t(`partnerKind.${p.kind}`, "en")}</Badge>
                  </Td>
                  <Td className="tabular-nums">{clientsBy.get(p.id) ?? 0}</Td>
                  <Td className="tabular-nums">{docsBy.get(p.id) ?? 0}</Td>
                  <Td colSpan={3}>
                    <form action={setPartnerPlan} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="workshop_id" value={p.id} />
                      <Select
                        name="plan"
                        defaultValue={p.plan}
                        aria-label={`Product for ${p.trading_name || p.name}`}
                        className="w-40"
                      >
                        {WORKSHOP_PLANS.map((plan) => (
                          <option key={plan} value={plan}>
                            {t(workshopPlanNameKey(plan), "en")}
                          </option>
                        ))}
                      </Select>
                      <span className="tabular-nums text-sand-600">{priceLabel(p.plan)}</span>
                      <SubmitButton variant="secondary" size="sm">Save</SubmitButton>
                    </form>
                  </Td>
                </Tr>
              ))}
              {partners.length === 0 ? (
                <Tr>
                  <Td colSpan={7} className="text-sand-500">
                    No partners yet.
                  </Td>
                </Tr>
              ) : null}
            </Tbody>
          </Table>
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>What the three products are</CardTitle></CardHeader>
        <dl className="flex flex-col gap-3 text-sm">
          <div>
            <dt className="font-medium text-sand-900">Portal — {priceLabel("portal")}</dt>
            <dd className="text-sand-600">
              Their customers see their fleet with the partner in it: work requests, vehicle history, their own
              letterhead, and attaching the quotes and invoices they already produce elsewhere. Their existing
              system stays their system.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-sand-900">Managed — {priceLabel("managed")}</dt>
            <dd className="text-sand-600">
              Everything above, plus billing their customers here: quotes and invoices built line by line,
              quote-to-invoice conversion, statements of account, payments and proofs, and cross-client analytics.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-sand-900">Books — {priceLabel("books")}</dt>
            <dd className="text-sand-600">
              Everything above, plus running the business here rather than only billing from it: profit and loss,
              cash-flow forecasting, the VAT return, expenses and receipts, suppliers, purchase orders, standing
              costs and bank reconciliation. The difference between writing the invoice and knowing whether the
              month made money.
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-sand-500">
          Prices are not set yet, so this console shows a dash rather than a number. Nothing here charges
          anyone either way — the billing adapter is still the no-op.
        </p>
      </Card>
    </div>
  );
}
