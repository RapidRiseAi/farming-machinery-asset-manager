import { requireRole } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import {
  WORKSHOP_PLANS,
  WORKSHOP_PLAN_PRICE_MONTHLY,
  isWorkshopPlan,
  workshopPlanNameKey,
} from "@/lib/contractor-plan";
import { num } from "@/lib/format";
import { setPartnerPlan } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { ActionMenu } from "@/components/ui/action-menu";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Disclosure } from "@/components/ui/disclosure";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Stat, StatGrid } from "@/components/ui/stat";

/**
 * Which product each partner is on (F14e). Internal, English-only like the rest of the
 * RR console.
 *
 * The price column is DISPLAY ONLY and VAT-inclusive, matching the founder decision that
 * governs the farm-plan display next door. Nothing here charges anyone, the billing
 * adapter is still the no-op, but a console that shows the product without the price
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
  // The profile was discarded here, so this page had no locale to translate with.
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
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
  // No price is never shown as a zero: "R0,00 a month" reads as a decision somebody made,
  // and this console is where the product gets quoted from.
  const priceOf = (plan: string) =>
    WORKSHOP_PLAN_PRICE_MONTHLY[plan as keyof typeof WORKSHOP_PLAN_PRICE_MONTHLY] ?? null;
  // "Not priced yet" where a price has not been set, never a zero and never a bare dash:
  // a dash after a comma read as a broken sentence ("Portal, -").
  const priceLabel = (plan: string) => {
    const p = priceOf(plan);
    return p == null ? "Not priced yet" : `${rands(p * 100)} a month`;
  };
  const planName = (plan: string) =>
    isWorkshopPlan(plan) ? t(workshopPlanNameKey(plan), "en") : plan;
  const priced = partners.filter((p) => priceOf(p.plan) != null);
  const indicativeMonthly = priced.reduce((sum, p) => sum + (priceOf(p.plan) ?? 0), 0);

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Partners"
        lead="Which product each partner is on. Changing it records the product; nothing here charges anyone."
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      <StatGrid columns={3}>
        <Stat label="Partners" value={num(partners.length)} size="md" />
        <Stat label="On Books" value={num(onBooks)} size="md" />
        <Stat
          label="Indicative a month"
          value={priced.length === 0 ? "Not priced yet" : rands(indicativeMonthly * 100)}
          valueKind={priced.length === 0 ? "text" : "number"}
          delta={priced.length === 0 ? undefined : `${num(priced.length)} priced, VAT incl., display only`}
          size="md"
        />
      </StatGrid>

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
                <Th>Product</Th>
                <Th><span className="sr-only">{t("common.actions", "en")}</span></Th>
              </Tr>
            </Thead>
            <Tbody>
              {partners.map((p) => {
                const name = p.trading_name || p.name;
                return (
                  <Tr key={p.id}>
                    <Td>
                      <span className="font-medium text-sand-900">{name}</span>
                      {p.area ? <span className="block text-xs text-sand-500">{p.area}</span> : null}
                    </Td>
                    <Td>
                      <Badge tone="neutral">{t(`partnerKind.${p.kind}`, "en")}</Badge>
                    </Td>
                    <Td className="tnum">{num(clientsBy.get(p.id) ?? 0)}</Td>
                    <Td className="tnum">{num(docsBy.get(p.id) ?? 0)}</Td>
                    <Td>
                      <Badge tone={p.plan === "books" ? "brand" : "neutral"}>{planName(p.plan)}</Badge>
                      <span className="tnum mt-0.5 block text-xs text-sand-500">{priceLabel(p.plan)}</span>
                    </Td>
                    <Td className="text-right">
                      <ActionMenu title={name} label={`Actions for ${name}`} closeLabel={t("ui.close", "en")}>
                        <DialogForm
                          triggerLook="menuItem"
                          trigger="Change product"
                          title="Change product"
                          description={name}
                          closeLabel={t("ui.close", "en")}
                          size="md"
                        >
                          <form action={setPartnerPlan}>
                            <input type="hidden" name="workshop_id" value={p.id} />
                            <DialogFields columns={1}>
                              <SelectField
                                name="plan"
                                id={`plan-${p.id}`}
                                label="Product"
                                defaultValue={p.plan}
                                hint="This records which product they are on. It charges nobody."
                              >
                                {WORKSHOP_PLANS.map((plan) => (
                                  <option key={plan} value={plan}>
                                    {priceOf(plan) == null ? planName(plan) : `${planName(plan)}, ${priceLabel(plan)}`}
                                  </option>
                                ))}
                              </SelectField>
                            </DialogFields>
                            <DialogActions cancelLabel={t("common.cancel", "en")}>
                              <SubmitButton>{t("common.save", "en")}</SubmitButton>
                            </DialogActions>
                          </form>
                        </DialogForm>
                      </ActionMenu>
                    </Td>
                  </Tr>
                );
              })}
              {partners.length === 0 ? (
                <Tr>
                  <Td colSpan={6} className="text-sand-500">
                    No partners yet.
                  </Td>
                </Tr>
              ) : null}
            </Tbody>
          </Table>
        </div>
      </Card>

      <Disclosure summary="What the three products are" variant="card">
        <dl className="flex flex-col gap-4 text-sm">
          <div>
            <dt className="flex flex-wrap items-baseline justify-between gap-x-3 font-medium text-sand-900">
              <span>Portal</span>
              <span className="tnum text-xs font-normal text-sand-500">{priceLabel("portal")}</span>
            </dt>
            <dd className="mt-0.5 text-sand-600">
              Their customers see their fleet with the partner in it: work requests, vehicle history, their own
              letterhead, and attaching the quotes and invoices they already produce elsewhere. Their existing
              system stays their system.
            </dd>
          </div>
          <div>
            <dt className="flex flex-wrap items-baseline justify-between gap-x-3 font-medium text-sand-900">
              <span>Managed</span>
              <span className="tnum text-xs font-normal text-sand-500">{priceLabel("managed")}</span>
            </dt>
            <dd className="mt-0.5 text-sand-600">
              Everything in Portal, plus billing their customers here: quotes and invoices built line by line,
              quote-to-invoice conversion, statements of account, payments and proofs, and cross-client analytics.
            </dd>
          </div>
          <div>
            <dt className="flex flex-wrap items-baseline justify-between gap-x-3 font-medium text-sand-900">
              <span>Books</span>
              <span className="tnum text-xs font-normal text-sand-500">{priceLabel("books")}</span>
            </dt>
            <dd className="mt-0.5 text-sand-600">
              Everything in Managed, plus running the business here rather than only billing from it: profit and
              loss, cash-flow forecasting, the VAT return, expenses and receipts, suppliers, purchase orders,
              standing costs and bank reconciliation. The difference between writing the invoice and knowing
              whether the month made money.
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-sand-500">
          A product without a price says &ldquo;Not priced yet&rdquo; rather than R0,00. Nothing here charges
          anyone either way: the billing adapter is still the no-op.
        </p>
      </Disclosure>
    </PageContainer>
  );
}
