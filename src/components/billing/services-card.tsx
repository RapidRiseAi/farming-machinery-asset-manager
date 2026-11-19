import Link from "next/link";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Disclosure } from "@/components/ui/disclosure";
import { Fact, FactList } from "@/components/ui/facts";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { SubmitButton } from "@/components/ui/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { hoursLine, promiseLine, type SupportContact } from "@/components/support/support-parts";
import { shortDate } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { quantityLabel } from "@/lib/service-orders";
import { must, soft } from "@/lib/supabase/must";
import { createClient } from "@/lib/supabase/server";

type Action = (formData: FormData) => Promise<void>;

type Agreement = {
  id: string;
  reference: string;
  status: string;
  billing_period: "monthly" | "annual";
  scope: string;
  work_allowance: string;
  review_schedule: string;
  staff_owner: string;
  extras: string;
  assumptions: string | null;
  supplier_mandate: string | null;
  assumed_full_assets: number;
  assumed_equipment: number;
  space_period_incl_cents: number;
  min_spaces: number;
  equipment_included: number;
  equipment_period_incl_cents: number;
  recurring_incl_cents: number;
  term_months: number;
  effective_from: string;
  effective_until: string;
  expires_on: string;
  accepted_on: string | null;
  ends_on: string | null;
};

type Order = {
  id: string;
  code: string;
  quantity: number;
  amount_incl_cents: number;
  travel_incl_cents: number;
  scope: string;
  delivery: string;
  assumptions: string | null;
  status: string;
  expires_on: string;
};

type CatalogueRow = {
  code: string;
  name_en: string;
  name_af: string;
  unit_en: string;
  unit_af: string;
  unit_price_incl_cents: number;
  pricing: "per_unit" | "hourly" | "from";
  minimum_incl_cents: number | null;
  min_quantity: number | null;
  included_en: string | null;
  included_af: string | null;
  ready: boolean;
  requires_supplier_quote: boolean;
  sort: number;
};

type Review = { id: string; worked_on: string; note: string; outcome: string | null; next_review_on: string | null };

const AGREEMENT_COLUMNS =
  "id, reference, status, billing_period, scope, work_allowance, review_schedule, staff_owner, extras, assumptions, " +
  "supplier_mandate, assumed_full_assets, assumed_equipment, space_period_incl_cents, min_spaces, equipment_included, " +
  "equipment_period_incl_cents, recurring_incl_cents, term_months, effective_from, effective_until, expires_on, accepted_on, ends_on";
const ORDER_COLUMNS = "id, code, quantity, amount_incl_cents, travel_incl_cents, scope, delivery, assumptions, status, expires_on";
const CATALOGUE_COLUMNS =
  "code, name_en, name_af, unit_en, unit_af, unit_price_incl_cents, pricing, minimum_incl_cents, min_quantity, " +
  "included_en, included_af, ready, requires_supplier_quote, sort";

const fill = (s: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(v), s);

/** How a catalogue row is priced, in words, from the row itself. */
function ruleLine(row: CatalogueRow, locale: Lang): string {
  const unit = locale === "af" ? row.unit_af : row.unit_en;
  const price = rands(row.unit_price_incl_cents);
  if (row.pricing === "hourly") return fill(t("services.ruleHourly", locale), { price });
  if (row.pricing === "from") return fill(t("services.ruleFrom", locale), { price });
  if (row.minimum_incl_cents) return fill(t("services.ruleMinimum", locale), { price, unit, minimum: rands(row.minimum_incl_cents) });
  if (row.min_quantity && row.min_quantity > 1) return fill(t("services.ruleMinQuantity", locale), { price, unit, n: String(row.min_quantity) });
  return fill(t("services.ruleUnit", locale), { price, unit });
}

/**
 * Services from Rapid Rise on /billing (20261120100000): a Done-For-You agreement waiting for
 * the owner (every term and the explicit total, accepted in a dialog), the agreement in force
 * with its reviews, optional setup and training orders, the optional catalogue with its rules
 * (QR kits described by their readiness), and the support hours from the support settings.
 * The reads are the person's own: an owner sees the agreement, orders and reviews (RLS);
 * anyone else on the page sees only the catalogue and the hours.
 */
export async function ServicesCard({
  farmId,
  locale,
  canAccept,
  acceptAgreement,
  acceptOrder,
}: {
  farmId: string;
  locale: Lang;
  canAccept: boolean;
  acceptAgreement: Action;
  acceptOrder: Action;
}) {
  const supabase = await createClient();
  const [agreementsRead, ordersRead, reviewsRead, catalogueRead] = await Promise.all([
    supabase
      .from("done_for_you_quotes")
      .select(AGREEMENT_COLUMNS)
      .eq("farm_id", farmId)
      .in("status", ["offered", "accepted", "active"])
      .order("created_at", { ascending: false })
      .limit(5),
    supabase.from("service_orders").select(ORDER_COLUMNS).eq("farm_id", farmId).order("offered_at", { ascending: false }).limit(20),
    supabase
      .from("service_work_entries")
      .select("id, worked_on, note, outcome, next_review_on")
      .eq("farm_id", farmId)
      .eq("kind", "review")
      .order("worked_on", { ascending: false })
      .limit(12),
    supabase.from("billing_service_catalogue").select(CATALOGUE_COLUMNS).order("sort"),
  ]);
  // must: an offer that fails to load must not read as "nothing waiting for you".
  const agreements = (must(agreementsRead, "billing:services-agreements") as unknown as Agreement[] | null) ?? [];
  const orders = (must(ordersRead, "billing:services-orders") as unknown as Order[] | null) ?? [];
  const reviews = (must(reviewsRead, "billing:services-reviews") as unknown as Review[] | null) ?? [];
  const catalogue = (must(catalogueRead, "billing:services-catalogue") as unknown as CatalogueRow[] | null) ?? [];
  // soft: only the hours; the help page's defaults stand in for them.
  const contactRows = soft(await supabase.rpc("support_contact"), "billing:services-contact");
  const contact = ((contactRows as SupportContact[] | null) ?? [])[0] ?? null;

  const byCode = new Map(catalogue.map((c) => [c.code, c]));
  const offered = agreements.find((a) => a.status === "offered") ?? null;
  const accepted = agreements.find((a) => a.status === "accepted") ?? null;
  const active = agreements.find((a) => a.status === "active") ?? null;
  const per = (a: Agreement, cents: number) =>
    fill(t(a.billing_period === "annual" ? "services.perYear" : "services.perMonth", locale), { price: rands(cents) });

  const terms = (a: Agreement) => (
    <FactList>
      <Fact label={t("services.reference", locale)} value={a.reference} />
      <Fact
        label={t(a.billing_period === "annual" ? "services.totalAnnual" : "services.totalMonthly", locale)}
        value={rands(a.recurring_incl_cents)}
        hint={fill(t("services.totalNote", locale), { full: String(a.assumed_full_assets), equipment: String(a.assumed_equipment) })}
      />
      <Fact label={t("services.spacePrice", locale)} value={per(a, a.space_period_incl_cents)} />
      <Fact label={t("services.minimum", locale)} value={fill(t("services.minimumValue", locale), { n: String(a.min_spaces) })} />
      <Fact
        label={t("services.equipment", locale)}
        value={fill(t("services.equipmentValue", locale), { n: String(a.equipment_included), price: per(a, a.equipment_period_incl_cents) })}
      />
      <Fact label={t("services.scope", locale)} value={a.scope} />
      <Fact label={t("services.allowance", locale)} value={a.work_allowance} />
      <Fact label={t("services.reviews", locale)} value={a.review_schedule} />
      <Fact label={t("services.owner", locale)} value={a.staff_owner} />
      <Fact label={t("services.extras", locale)} value={a.extras} />
      {a.assumptions ? <Fact label={t("services.assumptions", locale)} value={a.assumptions} /> : null}
      <Fact label={t("services.supplier", locale)} value={a.supplier_mandate ?? t("services.supplierApproval", locale)} />
      <Fact
        label={t("services.term", locale)}
        value={fill(t("services.termValue", locale), {
          months: String(a.term_months),
          from: shortDate(a.effective_from, locale),
          until: shortDate(a.effective_until, locale),
        })}
      />
    </FactList>
  );

  return (
    <Card id="services">
      <CardHeader>
        <CardTitle>{t("services.title", locale)}</CardTitle>
      </CardHeader>
      <p className="text-sm leading-relaxed text-sand-700">{t("services.lead", locale)}</p>

      {offered ? (
        <section className="mt-4 rounded-xl border border-callout-info-edge bg-callout-info-bg p-3">
          <h3 className="text-sm font-semibold text-sand-900">{t("services.agreementOffered", locale)}</h3>
          {terms(offered)}
          <p className="mt-2 text-sm leading-relaxed text-sand-700">
            {fill(t("services.startsAt", locale), { date: shortDate(offered.effective_from, locale) })}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-sand-700">{t("services.notIncluded", locale)}</p>
          <p className="mt-2 text-xs text-sand-600">{fill(t("services.expires", locale), { date: shortDate(offered.expires_on, locale) })}</p>
          {canAccept ? (
            <div className="mt-3">
              <DialogForm
                trigger={t("services.acceptAgreement", locale)}
                title={t("services.acceptAgreementTitle", locale)}
                description={fill(t("services.acceptAgreementHelp", locale), {
                  date: shortDate(offered.effective_from, locale),
                  total: rands(offered.recurring_incl_cents),
                })}
                closeLabel={t("ui.close", locale)}
              >
                <form action={acceptAgreement}>
                  <RequestIdInput action="billing:accept-agreement" />
                  <input type="hidden" name="quote_id" value={offered.id} />
                  <input type="hidden" name="recurring_cents" value={String(offered.recurring_incl_cents)} />
                  <DialogFields>
                    <Checkbox name="accept" value="1" required label={t("services.acceptCheck", locale)} />
                  </DialogFields>
                  <DialogActions cancelLabel={t("common.cancel", locale)}>
                    <SubmitButton>{t("services.accept", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            </div>
          ) : null}
        </section>
      ) : null}

      {accepted ? (
        <section className="mt-4">
          <h3 className="text-sm font-semibold text-sand-900">{t("services.agreementAccepted", locale)}</h3>
          {terms(accepted)}
          <p className="mt-2 text-sm leading-relaxed text-sand-700">
            {fill(t("services.startsAt", locale), { date: shortDate(accepted.effective_from, locale) })}
          </p>
        </section>
      ) : null}

      {active ? (
        <section className="mt-4">
          <h3 className="text-sm font-semibold text-sand-900">{t("services.agreementActive", locale)}</h3>
          {terms(active)}
          {active.ends_on ? (
            <p className="mt-2 text-sm leading-relaxed text-sand-700">
              {fill(t("services.endsOn", locale), { date: shortDate(active.ends_on, locale) })}
            </p>
          ) : null}
          <p className="mt-2 text-sm leading-relaxed text-sand-700">{t("services.notIncluded", locale)}</p>
        </section>
      ) : null}

      {reviews.length > 0 ? (
        <Disclosure variant="inline" summary={t("services.reviewsTitle", locale)} meta={String(reviews.length)} className="mt-4">
          <ul className="flex flex-col gap-3 text-sm text-sand-800">
            {reviews.map((r) => (
              <li key={r.id}>
                <p className="font-medium text-sand-900">{shortDate(r.worked_on, locale)}: {r.note}</p>
                {r.outcome ? <p>{r.outcome}</p> : null}
                {r.next_review_on ? (
                  <p className="text-xs text-sand-600">{fill(t("services.reviewNext", locale), { date: shortDate(r.next_review_on, locale) })}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}

      {orders.length > 0 ? (
        <section className="mt-4">
          <h3 className="text-sm font-semibold text-sand-900">{t("services.ordersTitle", locale)}</h3>
          <ul className="mt-2 flex flex-col gap-3">
            {orders.map((o) => {
              const row = byCode.get(o.code);
              const name = row ? (locale === "af" ? row.name_af : row.name_en) : o.code;
              const unit = row ? (locale === "af" ? row.unit_af : row.unit_en) : "";
              return (
                <li key={o.id} className="rounded-xl border border-sand-200 p-3">
                  <p className="text-sm font-semibold text-sand-900">
                    {name}: {fill(t("services.orderQuantity", locale), { quantity: quantityLabel(Number(o.quantity)), unit })}
                  </p>
                  <FactList>
                    <Fact label={t("services.orderAmount", locale)} value={rands(o.amount_incl_cents)} />
                    <Fact label={t("services.orderStatus", locale)} value={t(`services.status.${o.status}`, locale)} />
                    <Fact label={t("services.orderScope", locale)} value={o.scope} />
                    <Fact label={t("services.orderDelivery", locale)} value={o.delivery} />
                    {o.assumptions ? <Fact label={t("services.assumptions", locale)} value={o.assumptions} /> : null}
                  </FactList>
                  {o.status === "offered" && canAccept ? (
                    <div className="mt-2">
                      <DialogForm
                        trigger={t("services.acceptOrder", locale)}
                        title={t("services.acceptOrderTitle", locale)}
                        description={fill(t("services.acceptOrderHelp", locale), { amount: rands(o.amount_incl_cents) })}
                        closeLabel={t("ui.close", locale)}
                        triggerVariant="secondary"
                      >
                        <form action={acceptOrder}>
                          <RequestIdInput action="billing:accept-order" />
                          <input type="hidden" name="order_id" value={o.id} />
                          <input type="hidden" name="amount_cents" value={String(o.amount_incl_cents)} />
                          <DialogFields>
                            <Checkbox name="accept" value="1" required label={t("services.acceptCheck", locale)} />
                          </DialogFields>
                          <DialogActions cancelLabel={t("common.cancel", locale)}>
                            <SubmitButton>{t("services.accept", locale)}</SubmitButton>
                          </DialogActions>
                        </form>
                      </DialogForm>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <Disclosure variant="inline" summary={t("services.catalogueTitle", locale)} className="mt-4">
        <p className="text-sm leading-relaxed text-sand-700">{t("services.catalogueFree", locale)}</p>
        <ul className="mt-2 flex flex-col gap-2 text-sm text-sand-800">
          {catalogue.map((c) => (
            <li key={c.code}>
              <p className="font-medium text-sand-900">{locale === "af" ? c.name_af : c.name_en}</p>
              <p>{c.ready ? ruleLine(c, locale) : t("services.notReady", locale)}</p>
              {(locale === "af" ? c.included_af : c.included_en) ? (
                <p className="text-xs text-sand-600">{locale === "af" ? c.included_af : c.included_en}</p>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm leading-relaxed text-sand-700">{t("services.catalogueNoStack", locale)}</p>
        <p className="mt-2 text-sm leading-relaxed text-sand-700">{t("services.dfyLine", locale)}</p>
        <p className="mt-2 text-sm leading-relaxed text-sand-700">{t("services.askToOrder", locale)}</p>
        <Link href="/help?from=/billing" className={`${buttonVariants({ variant: "secondary", size: "sm" })} mt-2`}>
          {t("services.askLink", locale)}
        </Link>
      </Disclosure>

      <FactList>
        <Fact label={t("services.supportTitle", locale)} value={hoursLine(contact, locale)} hint={promiseLine(contact, locale)} />
      </FactList>
    </Card>
  );
}
