import { ActionMenu } from "@/components/ui/action-menu";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogActions, DialogFields, DialogForm, DialogSection } from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { shortDate } from "@/lib/format";
import { rands } from "@/lib/money";
import { quantityLabel, WORK_ACTIVITIES } from "@/lib/service-orders";
import { must } from "@/lib/supabase/must";
import { createClient } from "@/lib/supabase/server";
import {
  cancelAgreement, closeOrder, endAgreement, invoiceOrder, logServiceWork, offerAgreement, offerOrder,
} from "./service-actions";

type Agreement = {
  id: string; reference: string; status: string; billing_period: string; recurring_incl_cents: number | null;
  per_vehicle_incl_cents: number; min_vehicles: number; effective_from: string | null; effective_until: string | null;
  accepted_on: string | null; ends_on: string | null; expires_on: string | null;
};
type Order = { id: string; code: string; quantity: number; amount_incl_cents: number; status: string; scope: string; expires_on: string; invoice_id: string | null };
type Entry = { id: string; kind: string; activity: string | null; minutes: number; worked_on: string; note: string; outcome: string | null };
type CatalogueRow = { code: string; name_en: string; unit_en: string; pricing: string; ready: boolean };

const ACTIVITY_LABELS: Record<(typeof WORK_ACTIVITIES)[number], string> = {
  maintenance_planning: "Maintenance planning",
  workshop_follow_up: "Workshop follow-up",
  cost_monitoring: "Cost monitoring",
  records: "Records",
  reporting: "Reporting",
  setup: "Setup",
  training: "Training",
  other: "Other",
};

/**
 * Done-For-You agreements, optional service orders and Rapid Rise's work record for one
 * customer (20261120100000). An agreement and an order are OFFERED here and accepted by the
 * owner on /billing; nothing here prices the subscription at once (the old path did). Internal
 * and English-only, like the rest of the console.
 */
export async function AdminServices({ farmId }: { farmId: string }) {
  const supabase = await createClient();
  const [agreementsRead, ordersRead, entriesRead, catalogueRead, machinesRead] = await Promise.all([
    supabase
      .from("done_for_you_quotes")
      .select("id, reference, status, billing_period, recurring_incl_cents, per_vehicle_incl_cents, min_vehicles, effective_from, effective_until, accepted_on, ends_on, expires_on")
      .eq("farm_id", farmId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase.from("service_orders").select("id, code, quantity, amount_incl_cents, status, scope, expires_on, invoice_id").eq("farm_id", farmId).order("offered_at", { ascending: false }).limit(30),
    supabase.from("service_work_entries").select("id, kind, activity, minutes, worked_on, note, outcome").eq("farm_id", farmId).order("worked_on", { ascending: false }).limit(30),
    supabase.from("billing_service_catalogue").select("code, name_en, unit_en, pricing, ready").neq("pricing", "quoted").eq("active", true).order("sort"),
    supabase.from("machines").select("id, name").eq("farm_id", farmId).is("deleted_at", null).order("name").limit(1000),
  ]);
  const agreements = (must(agreementsRead, "admin-services:agreements") ?? []) as Agreement[];
  const orders = (must(ordersRead, "admin-services:orders") ?? []) as Order[];
  const entries = (must(entriesRead, "admin-services:entries") ?? []) as Entry[];
  const catalogue = (must(catalogueRead, "admin-services:catalogue") ?? []) as CatalogueRow[];
  const machines = (must(machinesRead, "admin-services:machines") ?? []) as { id: string; name: string }[];
  const names = new Map(catalogue.map((c) => [c.code, c]));
  const today = new Date().toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const loggable = [
    ...agreements.filter((a) => ["active", "ended", "superseded"].includes(a.status)).map((a) => ({ value: `agreement:${a.id}`, label: `Agreement ${a.reference}` })),
    ...orders.filter((o) => ["accepted", "invoiced", "completed"].includes(o.status)).map((o) => ({ value: `order:${o.id}`, label: `${names.get(o.code)?.name_en ?? o.code} (${quantityLabel(Number(o.quantity))})` })),
  ];
  const monthStart = today.slice(0, 8) + "01";
  const minutesThisMonth = entries.filter((e) => e.kind === "work" && e.worked_on >= monthStart).reduce((n, e) => n + e.minutes, 0);

  return (
    <Card id="services">
      <CardHeader><CardTitle as="h3">Done-For-You and services</CardTitle></CardHeader>
      <p className="mb-3 text-sm text-sand-600">
        Offer an agreement or an order; the owner accepts it on their billing page. An agreement takes effect at their first
        renewal on or after its start date, through the ordinary invoice run, at the explicit prices offered. Floors: R170 a
        space and R2 500 a month (twelve times each for a year). Equipment in a managed quote is human work, never R15.
      </p>

      <h4 className="text-sm font-semibold text-sand-900">Agreements</h4>
      {agreements.length === 0 ? <p className="text-sm text-sand-600">None yet.</p> : (
        <ul className="mb-3 flex flex-col gap-2 text-sm text-sand-700">
          {agreements.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {a.reference}: {a.status}
                {a.recurring_incl_cents != null
                  ? `, ${rands(a.recurring_incl_cents)} a ${a.billing_period === "annual" ? "year" : "month"}`
                  : `, ${rands(a.per_vehicle_incl_cents)} a vehicle, minimum ${a.min_vehicles} (old path)`}
                {a.effective_from ? `, from ${shortDate(a.effective_from, "en")}` : ""}
                {a.accepted_on ? `, accepted ${shortDate(a.accepted_on, "en")}` : ""}
                {a.ends_on ? `, ends ${shortDate(a.ends_on, "en")}` : ""}
              </span>
              {["offered", "accepted", "active"].includes(a.status) ? (
                <ActionMenu title={a.reference} label="Actions" closeLabel="Close">
                  {a.status !== "active" ? (
                    <ConfirmDialog action={cancelAgreement} triggerLook="menuItem" triggerLabel="Withdraw the offer"
                      title={`Withdraw ${a.reference}`} intro="The owner can no longer accept it." confirmLabel="Withdraw"
                      cancelLabel="Cancel" closeLabel="Close">
                      <input type="hidden" name="farm_id" value={farmId} />
                      <input type="hidden" name="quote_id" value={a.id} />
                    </ConfirmDialog>
                  ) : (
                    <ConfirmDialog action={endAgreement} triggerLook="menuItem" triggerLabel="End at the next renewal"
                      title={`End ${a.reference}`} intro="The plan chosen lands at the next renewal on the current price list." confirmLabel="End it"
                      cancelLabel="Cancel" closeLabel="Close">
                      <input type="hidden" name="farm_id" value={farmId} />
                      <input type="hidden" name="quote_id" value={a.id} />
                      <Field label="Plan from the renewal" htmlFor={`end-plan-${a.id}`}>
                        <Select id={`end-plan-${a.id}`} name="next_plan" defaultValue="complete">
                          <option value="essential">Essential</option>
                          <option value="professional">Professional</option>
                          <option value="complete">Complete</option>
                        </Select>
                      </Field>
                    </ConfirmDialog>
                  )}
                </ActionMenu>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-3 text-sm font-semibold text-sand-900">Orders</h4>
      {orders.length === 0 ? <p className="text-sm text-sand-600">None yet.</p> : (
        <ul className="mb-3 flex flex-col gap-2 text-sm text-sand-700">
          {orders.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{names.get(o.code)?.name_en ?? o.code}, {quantityLabel(Number(o.quantity))} {names.get(o.code)?.unit_en ?? ""}: {rands(o.amount_incl_cents)}, {o.status}</span>
              {["offered", "accepted", "invoiced"].includes(o.status) ? (
                <ActionMenu title={names.get(o.code)?.name_en ?? o.code} label="Actions" closeLabel="Close">
                  {o.status === "accepted" ? (
                    <ConfirmDialog action={invoiceOrder} triggerLook="menuItem" triggerLabel="Raise the invoice"
                      title="Raise the invoice" intro={`One service invoice for ${rands(o.amount_incl_cents)}, the accepted amount.`}
                      confirmLabel="Raise it" cancelLabel="Cancel" closeLabel="Close" tone="brand">
                      <RequestIdInput action="admin:service-invoice" />
                      <input type="hidden" name="farm_id" value={farmId} />
                      <input type="hidden" name="order_id" value={o.id} />
                    </ConfirmDialog>
                  ) : null}
                  {o.status !== "offered" ? (
                    <ConfirmDialog action={closeOrder} triggerLook="menuItem" triggerLabel="Mark done"
                      title="Mark the work done" intro="Record that the agreed work was delivered." confirmLabel="Done"
                      cancelLabel="Cancel" closeLabel="Close" tone="brand">
                      <input type="hidden" name="farm_id" value={farmId} />
                      <input type="hidden" name="order_id" value={o.id} />
                      <input type="hidden" name="status" value="completed" />
                    </ConfirmDialog>
                  ) : null}
                  {o.status !== "invoiced" ? (
                    <ConfirmDialog action={closeOrder} triggerLook="menuItem" triggerLabel="Cancel the order"
                      title="Cancel the order" intro="Not invoiced, so nothing is owed." confirmLabel="Cancel the order"
                      cancelLabel="Keep it" closeLabel="Close">
                      <input type="hidden" name="farm_id" value={farmId} />
                      <input type="hidden" name="order_id" value={o.id} />
                      <input type="hidden" name="status" value="cancelled" />
                    </ConfirmDialog>
                  ) : null}
                </ActionMenu>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-3 text-sm font-semibold text-sand-900">Work and reviews</h4>
      <p className="text-sm text-sand-600">{Math.round(minutesThisMonth / 6) / 10} hours logged this month. The time record is Rapid Rise&apos;s; reviews are shown to the owner.</p>
      {entries.length > 0 ? (
        <ul className="mb-3 mt-1 flex flex-col gap-1 text-sm text-sand-700">
          {entries.slice(0, 12).map((e) => (
            <li key={e.id}>
              {shortDate(e.worked_on, "en")}: {e.kind === "work" ? `${ACTIVITY_LABELS[e.activity as keyof typeof ACTIVITY_LABELS] ?? e.activity}, ${e.minutes} min` : "Review"}: {e.note}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <DialogForm trigger="Offer an agreement" title="Offer a Done-For-You agreement" closeLabel="Close" size="lg"
          description="Every field below is shown to the owner before they accept. Personal names are not needed: name a role.">
          <form action={offerAgreement}>
            <RequestIdInput action="admin:dfy-offer" />
            <input type="hidden" name="farm_id" value={farmId} />
            <DialogFields>
              <Field label="Quote reference" htmlFor="dfy-ref" required><Input id="dfy-ref" name="reference" required maxLength={100} /></Field>
              <Field label="Billing" htmlFor="dfy-period">
                <Select id="dfy-period" name="billing_period" defaultValue="monthly">
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual (quoted individually, twelve months)</option>
                </Select>
              </Field>
              <Field label="Price per full space for the period (R)" htmlFor="dfy-space" required><Input id="dfy-space" name="space_price" inputMode="decimal" required /></Field>
              <Field label="Minimum full spaces billed" htmlFor="dfy-min" required><Input id="dfy-min" name="min_spaces" inputMode="numeric" required defaultValue="15" /></Field>
              <Field label="Equipment included" htmlFor="dfy-eq-inc" required><Input id="dfy-eq-inc" name="equipment_included" inputMode="numeric" required defaultValue="0" /></Field>
              <Field label="Price per further piece of equipment for the period (R)" htmlFor="dfy-eq" required><Input id="dfy-eq" name="equipment_price" inputMode="decimal" required /></Field>
              <Field label="Full assets assumed" htmlFor="dfy-full" required><Input id="dfy-full" name="assumed_full" inputMode="numeric" required /></Field>
              <Field label="Equipment assumed" htmlFor="dfy-eqa" required><Input id="dfy-eqa" name="assumed_equipment" inputMode="numeric" required defaultValue="0" /></Field>
              <Field label="Term (months)" htmlFor="dfy-term" required><Input id="dfy-term" name="term_months" inputMode="numeric" required defaultValue="12" /></Field>
              <Field label="Starts at the first renewal on or after" htmlFor="dfy-from" required><Input id="dfy-from" name="effective_from" type="date" required defaultValue={today} /></Field>
              <Field label="Offer open until" htmlFor="dfy-exp" required><Input id="dfy-exp" name="expires_on" type="date" required defaultValue={inDays(14)} /></Field>
            </DialogFields>
            <DialogSection title="The work">
              <DialogFields columns={1}>
                <Field label="Scope (the work)" htmlFor="dfy-scope" required><Textarea id="dfy-scope" name="scope" rows={3} required maxLength={2000} /></Field>
                <Field label="Work allowance included" htmlFor="dfy-allow" required><Textarea id="dfy-allow" name="work_allowance" rows={2} required maxLength={1000} /></Field>
                <Field label="Review and report schedule" htmlFor="dfy-rev" required><Input id="dfy-rev" name="review_schedule" required maxLength={500} /></Field>
                <Field label="Looked after by (a role)" htmlFor="dfy-owner" required><Input id="dfy-owner" name="staff_owner" required maxLength={200} defaultValue="Fleet coordinator, Rapid Rise" /></Field>
                <Field label="What costs extra" htmlFor="dfy-extras" required><Textarea id="dfy-extras" name="extras" rows={2} required maxLength={1000} /></Field>
                <Field label="Asset assumptions" htmlFor="dfy-assume"><Textarea id="dfy-assume" name="assumptions" rows={2} maxLength={1000} /></Field>
                <Field label="Supplier spending mandate (leave empty: the owner approves every cost)" htmlFor="dfy-mandate"><Textarea id="dfy-mandate" name="supplier_mandate" rows={2} maxLength={1000} /></Field>
              </DialogFields>
            </DialogSection>
            <DialogActions cancelLabel="Cancel"><SubmitButton>Offer it</SubmitButton></DialogActions>
          </form>
        </DialogForm>

        <DialogForm trigger="Offer an order" title="Offer an optional service" closeLabel="Close" triggerVariant="secondary"
          description="The amount comes from the catalogue's rules; the owner sees the quantity, scope and delivery and accepts before any invoice. Clean setup and document capture are never both for the same work.">
          <form action={offerOrder}>
            <RequestIdInput action="admin:service-offer" />
            <input type="hidden" name="farm_id" value={farmId} />
            <DialogFields>
              <Field label="Service" htmlFor="so-code" required>
                <Select id="so-code" name="code" required defaultValue="">
                  <option value="" disabled>Choose</option>
                  {catalogue.map((c) => (
                    <option key={c.code} value={c.code} disabled={!c.ready}>{c.name_en}{c.ready ? "" : " (not ready: supplier quote needed)"}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Quantity (assets, hours or 1 visit)" htmlFor="so-qty" required><Input id="so-qty" name="quantity" inputMode="decimal" required /></Field>
              <Field label="Agreed total for on-site training (R)" htmlFor="so-quoted"><Input id="so-quoted" name="quoted" inputMode="decimal" /></Field>
              <Field label="Agreed travel for on-site training (R)" htmlFor="so-travel"><Input id="so-travel" name="travel" inputMode="decimal" /></Field>
              <Field label="Which work (setup only: one live setup order per piece of work)" htmlFor="so-key"><Input id="so-key" name="work_key" maxLength={100} /></Field>
              <Field label="Offer open until" htmlFor="so-exp" required><Input id="so-exp" name="expires_on" type="date" required defaultValue={inDays(14)} /></Field>
            </DialogFields>
            <DialogFields columns={1}>
              <Field label="Scope" htmlFor="so-scope" required><Textarea id="so-scope" name="scope" rows={2} required maxLength={2000} /></Field>
              <Field label="Delivery, fitting and travel" htmlFor="so-delivery" required><Textarea id="so-delivery" name="delivery" rows={2} required maxLength={1000} /></Field>
              <Field label="Assumptions" htmlFor="so-assume"><Textarea id="so-assume" name="assumptions" rows={2} maxLength={1000} /></Field>
              <Field label="Assets covered (ids, optional)" htmlFor="so-machines"><Textarea id="so-machines" name="machine_ids" rows={2} /></Field>
            </DialogFields>
            <DialogActions cancelLabel="Cancel"><SubmitButton>Offer it</SubmitButton></DialogActions>
          </form>
        </DialogForm>

        {loggable.length > 0 ? (
          <DialogForm trigger="Log work or a review" title="Log work or a review" closeLabel="Close" triggerVariant="secondary">
            <form action={logServiceWork}>
              <RequestIdInput action="admin:service-log" />
              <input type="hidden" name="farm_id" value={farmId} />
              <DialogFields>
                <Field label="For" htmlFor="sl-target" required>
                  <Select id="sl-target" name="target" required>
                    {loggable.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </Select>
                </Field>
                <Field label="Kind" htmlFor="sl-kind">
                  <Select id="sl-kind" name="kind" defaultValue="work">
                    <option value="work">Work (time)</option>
                    <option value="review">Review (shown to the owner)</option>
                  </Select>
                </Field>
                <Field label="Activity (work)" htmlFor="sl-activity">
                  <Select id="sl-activity" name="activity" defaultValue="maintenance_planning">
                    {WORK_ACTIVITIES.map((a) => <option key={a} value={a}>{ACTIVITY_LABELS[a]}</option>)}
                  </Select>
                </Field>
                <Field label="Asset (optional)" htmlFor="sl-machine">
                  <Select id="sl-machine" name="machine_id" defaultValue="">
                    <option value="">None</option>
                    {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Select>
                </Field>
                <Field label="Minutes (work)" htmlFor="sl-min"><Input id="sl-min" name="minutes" inputMode="numeric" /></Field>
                <Field label="Date" htmlFor="sl-date" required><Input id="sl-date" name="worked_on" type="date" required defaultValue={today} /></Field>
                <Field label="Next review (review)" htmlFor="sl-next"><Input id="sl-next" name="next_review_on" type="date" /></Field>
              </DialogFields>
              <DialogFields columns={1}>
                <Field label="Note" htmlFor="sl-note" required><Textarea id="sl-note" name="note" rows={2} required maxLength={4000} /></Field>
                <Field label="Outcome for the owner (review)" htmlFor="sl-outcome"><Textarea id="sl-outcome" name="outcome" rows={2} maxLength={4000} /></Field>
              </DialogFields>
              <DialogActions cancelLabel="Cancel"><SubmitButton>Save</SubmitButton></DialogActions>
            </form>
          </DialogForm>
        ) : null}
      </div>
    </Card>
  );
}
