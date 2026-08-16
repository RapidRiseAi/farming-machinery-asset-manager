"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, currentWorkshop, requireWorkshopEntitlement } from "@/lib/auth";
import { isDuplicateName } from "@/lib/suppliers";

/**
 * The supplier book (G18).
 *
 * Workshop-scoped rows behind the 0480 policy set, so every write goes through the ordinary
 * RLS client and the `workshop_id` comes from the session rather than from the form. A
 * guessed id belonging to another workshop matches zero rows instead of somebody else's
 * supplier — which is why the updates below carry no workshop filter of their own.
 *
 * Nothing here touches `partner_expenses.supplier_id`. Attaching an expense to a supplier is
 * the 0481 trigger's job, from the name, so that every other writer in the product — the
 * capture form, the purchase-order conversion, the seed, an import — keeps working without
 * knowing this table exists.
 */

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

/**
 * Payment terms as a whole number of days. Anything unparseable becomes null — "no term
 * agreed" — rather than 0, which would mean cash on delivery and would then be reported as
 * an overdue account the moment the invoice was captured.
 */
function terms(fd: FormData): number | null {
  const raw = String(fd.get("payment_terms_days") ?? "").trim();
  if (raw === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 365) return null;
  return n;
}

function fields(fd: FormData) {
  return {
    contact_person: s(fd, "contact_person"),
    phone: s(fd, "phone"),
    email: s(fd, "email"),
    address: s(fd, "address"),
    vat_number: s(fd, "vat_number"),
    account_number: s(fd, "account_number"),
    payment_terms_days: terms(fd),
    notes: s(fd, "notes"),
  };
}

export async function createSupplier(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");
  await requireWorkshopEntitlement("financials", "/suppliers");

  const name = s(formData, "name");
  if (!name) redirect("/suppliers?error=need-name");

  const supabase = await createClient();
  const { error } = await supabase.from("suppliers").insert({
    workshop_id: workshop.id,
    name,
    ...fields(formData),
    created_by: profile.id,
  });

  // The duplicate is the failure people actually hit, and the database refusing it is the
  // feature working: one business, one record. It gets a sentence rather than a constraint
  // name, and the existing record is already on the screen they land back on.
  if (error) redirect(`/suppliers?error=${isDuplicateName(error) ? "duplicate" : encodeURIComponent(error.message)}`);
  revalidatePath("/suppliers");
  revalidatePath("/expenses");
  redirect("/suppliers?saved=1");
}

export async function updateSupplier(formData: FormData) {
  await requireRole(["workshop"]);
  await requireWorkshopEntitlement("financials", "/suppliers");
  const id = String(formData.get("supplier_id") ?? "");
  const name = s(formData, "name");
  if (!id) redirect("/suppliers?error=not-found");
  if (!name) redirect("/suppliers?error=need-name");

  const supabase = await createClient();
  const { error } = await supabase
    .from("suppliers")
    .update({ name, ...fields(formData), updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) redirect(`/suppliers?error=${isDuplicateName(error) ? "duplicate" : encodeURIComponent(error.message)}`);
  revalidatePath("/suppliers");
  revalidatePath("/expenses");
  redirect("/suppliers?saved=1");
}

/**
 * Stop using a supplier, or start again.
 *
 * Deactivating takes the supplier out of the pickers and changes nothing else: every
 * invoice already captured against it keeps its link, keeps aging on /money and keeps its
 * place on the VAT return. That separation is the whole reason `active` exists alongside
 * the soft delete — "we do not buy from them any more" and "this record should never have
 * existed" are different statements and only one of them may touch history.
 */
export async function setSupplierActive(formData: FormData) {
  await requireRole(["workshop"]);
  await requireWorkshopEntitlement("financials", "/suppliers");
  const id = String(formData.get("supplier_id") ?? "");
  if (!id) redirect("/suppliers?error=not-found");
  const active = String(formData.get("active") ?? "") === "1";

  const supabase = await createClient();
  const { error } = await supabase
    .from("suppliers")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) redirect(`/suppliers?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/suppliers");
  revalidatePath("/expenses");
  redirect("/suppliers?saved=1");
}

/**
 * Soft delete, like everything else in this schema.
 *
 * The invoices that pointed at this record keep their `supplier_id` — the row still exists,
 * it is simply no longer visible — so nothing about the money changes. What DOES change is
 * the payables ageing: 0482 joins through RLS, so a deleted supplier stops supplying the
 * heading and those invoices fall back to grouping under their own typed name. The confirm
 * dialog says so, because "the total moved" is otherwise a mystery.
 */
export async function deleteSupplier(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  await requireWorkshopEntitlement("financials", "/suppliers");
  const id = String(formData.get("supplier_id") ?? "");
  if (!id) redirect("/suppliers?error=not-found");

  const supabase = await createClient();
  const { error } = await supabase
    .from("suppliers")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);

  if (error) redirect(`/suppliers?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/suppliers");
  revalidatePath("/expenses");
  redirect("/suppliers?deleted=1");
}
