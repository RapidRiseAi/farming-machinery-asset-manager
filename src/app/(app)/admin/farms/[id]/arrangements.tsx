import { shortDate, num } from "@/lib/format";
import { rands } from "@/lib/money";
import { must } from "@/lib/supabase/must";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { recordDfyQuote, setBilledThrough } from "./arrangement-actions";

/**
 * How this business is billed, when it is not the standard way: through a main site, or on a
 * Done-For-You price agreed with them. Internal and English-only, like the RR console.
 */
export async function BillingArrangements({ farmId }: { farmId: string }) {
  const supabase = await createClient();
  const farm = must(
    await supabase.from("farms").select("id, billed_through").eq("id", farmId).maybeSingle(),
    "admin-arrangements:farm",
  ) as { id: string; billed_through: string | null } | null;
  const others = (must(
    await supabase.from("farms").select("id, name").neq("id", farmId).is("billed_through", null).is("deleted_at", null).order("name").limit(1000),
    "admin-arrangements:others",
  ) ?? []) as { id: string; name: string }[];
  const quotes = (must(
    await supabase
      .from("done_for_you_quotes")
      .select("id, reference, per_vehicle_incl_cents, min_vehicles, billing_period, accepted_on")
      .eq("farm_id", farmId)
      .order("created_at", { ascending: false })
      .limit(10),
    "admin-arrangements:quotes",
  ) ?? []) as { id: string; reference: string; per_vehicle_incl_cents: number; min_vehicles: number; billing_period: string; accepted_on: string }[];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <Card>
        <CardHeader><CardTitle as="h3">One bill for several sites</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-sand-600">
          Bill this site through the business&apos;s main site: the main site&apos;s slots then cover this site&apos;s vehicles too,
          and this site opens and pauses with it. This site must not have a subscription of its own.
        </p>
        <form action={setBilledThrough} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="farm_id" value={farmId} />
          <div className="min-w-0 flex-1 basis-64">
            <Field label="Billed through" htmlFor="ba_parent">
              <Select id="ba_parent" name="billed_through" defaultValue={farm?.billed_through ?? ""}>
                <option value="">Its own bill</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </Select>
            </Field>
          </div>
          <SubmitButton variant="secondary">Save</SubmitButton>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle as="h3">Done-For-You quote</CardTitle></CardHeader>
        <p className="mb-3 text-sm text-sand-600">
          Record the quote they accepted. It becomes their price from the next invoice. The minimum is a number of vehicles,
          because that is what invoices bill in: R2 500 at R170 a vehicle is 15 vehicles (R2 550).
        </p>
        {quotes.length > 0 ? (
          <ul className="mb-3 text-sm text-sand-700">
            {quotes.map((q) => (
              <li key={q.id}>
                {q.reference}: {rands(q.per_vehicle_incl_cents)} a vehicle, minimum {num(q.min_vehicles)}, {q.billing_period}, accepted {shortDate(q.accepted_on, "en")}
              </li>
            ))}
          </ul>
        ) : null}
        <form action={recordDfyQuote} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="farm_id" value={farmId} />
          <Field label="Quote reference" htmlFor="dfy_ref" required>
            <Input id="dfy_ref" name="reference" required maxLength={100} />
          </Field>
          <Field label="Price a vehicle a month (R)" htmlFor="dfy_price" required>
            <Input id="dfy_price" name="per_vehicle" inputMode="decimal" required />
          </Field>
          <Field label="Minimum vehicles billed" htmlFor="dfy_min" required>
            <Input id="dfy_min" name="min_vehicles" inputMode="numeric" required defaultValue="0" />
          </Field>
          <Field label="Billing" htmlFor="dfy_period">
            <Select id="dfy_period" name="billing_period" defaultValue="monthly">
              <option value="monthly">Monthly</option>
              <option value="annual">Annual (ten months charged)</option>
            </Select>
          </Field>
          <Field label="Accepted on" htmlFor="dfy_date" required>
            <Input id="dfy_date" name="accepted_on" type="date" required defaultValue={today} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes" htmlFor="dfy_notes">
              <Textarea id="dfy_notes" name="notes" rows={2} maxLength={2000} />
            </Field>
          </div>
          <div className="sm:col-span-2"><SubmitButton>Record the quote</SubmitButton></div>
        </form>
      </Card>
    </>
  );
}
