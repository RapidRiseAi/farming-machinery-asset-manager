import { requireRole } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { readAll } from "@/lib/supabase/read-all";
import { mustAll } from "@/lib/supabase/must";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import {
  WORKSHOP_PLANS,
  WORKSHOP_PLAN_PRICE_MONTHLY,
  isWorkshopPlan,
  workshopPlanNameKey,
} from "@/lib/contractor-plan";
import { num, shortDate } from "@/lib/format";
import { approveApplication, deleteApplication, reviewApplication, setPartnerPlan } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { ActionMenu } from "@/components/ui/action-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
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

type Application = {
  id: string;
  business_name: string;
  kind: string;
  contact_name: string;
  email: string;
  phone: string;
  area: string;
  website: string | null;
  offer: string;
  vouch: string | null;
  plan_interest: string | null;
  status: string;
  review_notes: string | null;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  talking: "Talking",
  approved: "Approved",
  declined: "Declined",
};

/** One request. Everything in it was typed by a stranger, so it is shown as plain text. */
function ApplicationRow({ a, locale }: { a: Application; locale: "en" }) {
  const close = t("ui.close", "en");
  const cancel = t("common.cancel", "en");
  const interest = a.plan_interest && isWorkshopPlan(a.plan_interest) ? t(workshopPlanNameKey(a.plan_interest), "en") : "Not sure yet";
  const facts: [string, string | null][] = [
    ["Contact", a.contact_name],
    ["Email", a.email],
    ["Phone", a.phone],
    ["Where they work", a.area],
    ["Website", a.website],
    ["What they offer", a.offer],
    ["Reviews or who can vouch", a.vouch],
    ["Interested in", interest],
  ];
  return (
    <Tr>
      <Td>
        <span className="font-medium text-sand-900">{a.business_name}</span>
        <span className="block text-xs text-sand-500">{a.area}</span>
      </Td>
      <Td>
        <Badge tone="neutral">{t(`partnerKind.${a.kind}`, "en")}</Badge>
      </Td>
      <Td>
        <span className="block">{a.contact_name}</span>
        <span className="block break-all text-xs text-sand-500">{a.email}</span>
      </Td>
      <Td className="tnum">{shortDate(a.created_at, locale)}</Td>
      <Td>
        <Badge tone={a.status === "approved" ? "ok" : a.status === "new" ? "brand" : "neutral"}>
          {STATUS_LABEL[a.status] ?? a.status}
        </Badge>
      </Td>
      <Td className="text-right">
        <ActionMenu title={a.business_name} label={`Actions for ${a.business_name}`} closeLabel={close}>
          <DialogForm triggerLook="menuItem" trigger="Review" title={a.business_name} closeLabel={close} size="md">
            <dl className="flex flex-col gap-2 text-sm">
              {facts.map(([label, value]) =>
                value ? (
                  <div key={label}>
                    <dt className="font-medium text-sand-900">{label}</dt>
                    <dd className="whitespace-pre-wrap break-words text-sand-600">{value}</dd>
                  </div>
                ) : null,
              )}
            </dl>
            {a.status === "approved" ? null : (
              <form action={reviewApplication} className="mt-4">
                <input type="hidden" name="id" value={a.id} />
                <DialogFields columns={1}>
                  <SelectField name="status" id={`st-${a.id}`} label="Where it stands" defaultValue={a.status}>
                    <option value="new">New</option>
                    <option value="talking">Talking</option>
                    <option value="declined">Declined</option>
                  </SelectField>
                  <Field label="Your notes" htmlFor={`rn-${a.id}`}>
                    <Textarea id={`rn-${a.id}`} name="review_notes" rows={3} defaultValue={a.review_notes ?? ""} />
                  </Field>
                </DialogFields>
                <DialogActions cancelLabel={cancel}>
                  <SubmitButton>{t("common.save", "en")}</SubmitButton>
                </DialogActions>
              </form>
            )}
          </DialogForm>

          {a.status === "approved" ? null : (
            <DialogForm
              triggerLook="menuItem"
              trigger="Approve"
              title={`Approve ${a.business_name}`}
              description="This makes their account and emails them a sign-in link. Agree the terms with them first."
              closeLabel={close}
              size="md"
            >
              <form action={approveApplication}>
                <input type="hidden" name="id" value={a.id} />
                <DialogFields columns={1}>
                  <SelectField
                    name="plan"
                    id={`ap-${a.id}`}
                    label="Product"
                    defaultValue={a.plan_interest ?? "portal"}
                    hint="What you agreed with them. It charges nobody, and you can change it later."
                  >
                    {WORKSHOP_PLANS.map((plan) => (
                      <option key={plan} value={plan}>{t(workshopPlanNameKey(plan), "en")}</option>
                    ))}
                  </SelectField>
                </DialogFields>
                <DialogActions cancelLabel={cancel}>
                  <SubmitButton>Approve and email them</SubmitButton>
                </DialogActions>
              </form>
            </DialogForm>
          )}

          {a.status === "approved" || a.status === "declined" ? (
            <ConfirmDialog
              action={deleteApplication}
              triggerLook="menuItem"
              triggerLabel={t("common.delete", "en")}
              title={`Delete the request from ${a.business_name}`}
              intro="This removes what they sent, including anyone they named. An approved partner keeps their account."
              confirmLabel={t("common.delete", "en")}
              cancelLabel={cancel}
              closeLabel={close}
            >
              <input type="hidden" name="id" value={a.id} />
            </ConfirmDialog>
          ) : null}
        </ActionMenu>
      </Td>
    </Tr>
  );
}

function ApplicationTable({ rows }: { rows: Application[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <Thead>
          <Tr>
            <Th>Business</Th>
            <Th>Trade</Th>
            <Th>Contact</Th>
            <Th>Asked</Th>
            <Th>Status</Th>
            <Th><span className="sr-only">{t("common.actions", "en")}</span></Th>
          </Tr>
        </Thead>
        <Tbody>
          {rows.map((a) => (
            <ApplicationRow key={a.id} a={a} locale="en" />
          ))}
        </Tbody>
      </Table>
    </div>
  );
}

export default async function AdminPartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; approved?: string; removed?: string }>;
}) {
  // The profile was discarded here, so this page had no locale to translate with.
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const supabase = await createClient();

  // Links and documents are counted by the database, one row per partner: counting rows
  // here stopped at the API's thousandth document on the platform (20261013090000).
  type Activity = { workshop_id: string; active_clients: number; documents: number };
  const results = await Promise.all([
    readAll(() => supabase
      .from("workshops")
      .select("id, name, trading_name, kind, plan, area, created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })),
    readAll<Activity>(() => supabase.rpc("admin_partner_activity"), { key: "workshop_id" }),
    readAll(() => supabase
      .from("partner_applications")
      .select("id, business_name, kind, contact_name, email, phone, area, website, offer, vouch, plan_interest, status, review_notes, created_at")
      .order("created_at", { ascending: false })),
  ]);
  // A failed read showed "No partners yet", or every partner with no clients or documents.
  mustAll(results, "admin-partners:list");
  const [{ data: wData }, { data: activityData }, { data: applicationData }] = results;
  const applications = (applicationData as Application[] | null) ?? [];
  const openRequests = applications.filter((a) => a.status === "new" || a.status === "talking");
  const decidedRequests = applications.filter((a) => a.status === "approved" || a.status === "declined");

  const partners = (wData as Row[] | null) ?? [];
  const activity = (activityData as Activity[] | null) ?? [];
  const clientsBy = new Map(activity.map((a) => [a.workshop_id, a.active_clients]));
  const docsBy = new Map(activity.map((a) => [a.workshop_id, a.documents]));

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
      <Flash tone="success" message={sp.approved === "1" ? "Approved. They have been emailed a sign-in link." : sp.removed ? "Request deleted." : undefined} />
      <Flash
        tone="error"
        message={sp.approved === "nomail" ? "Approved, but the email did not go. They can ask for a sign-in link on the sign-in page, using the address they applied with." : undefined}
      />

      <Card>
        <CardHeader><CardTitle>Partner requests</CardTitle></CardHeader>
        {openRequests.length === 0 ? (
          <p className="text-sm text-sand-500">No open requests. Businesses ask at /become-a-partner.</p>
        ) : (
          <ApplicationTable rows={openRequests} />
        )}
      </Card>
      {decidedRequests.length > 0 ? (
        <Disclosure summary={`Decided requests (${num(decidedRequests.length)})`} variant="card">
          <ApplicationTable rows={decidedRequests} />
        </Disclosure>
      ) : null}

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
