import { must } from "@/lib/supabase/must";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { setBilledThrough } from "./arrangement-actions";
import { AdminServices } from "./services";

/**
 * How this business is billed, when it is not the standard way: through a main site, or on a
 * Done-For-You agreement (services.tsx). Internal and English-only, like the RR console.
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

      <AdminServices farmId={farmId} />
    </>
  );
}
