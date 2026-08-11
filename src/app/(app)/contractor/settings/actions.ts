"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireRole } from "@/lib/auth";
import { normaliseHex, DEFAULT_BRAND_PRIMARY, DEFAULT_BRAND_SECONDARY } from "@/lib/branding";
import { percentToBps } from "@/lib/format";
import { LAYOUT_SWITCHES } from "@/lib/doc-layout";

/**
 * A partner maintaining its own business profile and letterhead (F14a).
 *
 * Writes go through the RLS-bound client and land on the partner's OWN workshop row —
 * the `workshops_upd_self` policy (0380) allows exactly that row and no other, and the
 * `workshops_guard_plan` trigger rejects any attempt to change the paid product from
 * here. So there is nothing to check about which workshop is being edited: the database
 * will not let this action touch another one. We still pin `.eq("id", workshop_id)` so a
 * mistake surfaces as "no rows updated" rather than a silent broad update.
 */

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

function intIn(fd: FormData, k: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(String(fd.get(k) ?? ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export async function updatePartnerProfile(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  if (!profile.workshop_id) redirect("/contractor?error=no-workshop");

  const supabase = await createClient();
  const { error } = await supabase
    .from("workshops")
    .update({
      name: String(formData.get("name") ?? "").trim() || undefined,
      trading_name: s(formData, "trading_name"),
      reg_number: s(formData, "reg_number"),
      vat_number: s(formData, "vat_number"),
      address: s(formData, "address"),
      phone: s(formData, "phone"),
      whatsapp: s(formData, "whatsapp"),
      email: s(formData, "email"),
      website: s(formData, "website"),
      area: s(formData, "area"),
      bank_name: s(formData, "bank_name"),
      bank_account_name: s(formData, "bank_account_name"),
      bank_account_number: s(formData, "bank_account_number"),
      bank_branch_code: s(formData, "bank_branch_code"),
      bank_account_type: s(formData, "bank_account_type"),
      brand_primary: normaliseHex(String(formData.get("brand_primary") ?? "")) ?? DEFAULT_BRAND_PRIMARY,
      brand_secondary: normaliseHex(String(formData.get("brand_secondary") ?? "")) ?? DEFAULT_BRAND_SECONDARY,
      show_powered_by: formData.get("show_powered_by") != null,
      doc_prefix_quote: (s(formData, "doc_prefix_quote") ?? "QTE").slice(0, 8).toUpperCase(),
      doc_prefix_invoice: (s(formData, "doc_prefix_invoice") ?? "INV").slice(0, 8).toUpperCase(),
      // A credit note is its own kind of document under VAT Act s21, so it gets its own
      // series — sharing the invoice counter makes both unreadable in a partner's books.
      doc_prefix_credit: (s(formData, "doc_prefix_credit") ?? "CN").slice(0, 8).toUpperCase(),
      quote_validity_days: intIn(formData, "quote_validity_days", 0, 365, 14),
      invoice_terms_days: intIn(formData, "invoice_terms_days", 0, 365, 30),
      vat_registered: formData.get("vat_registered") != null,
      default_vat_rate_bps: percentToBps(String(formData.get("vat_percent") ?? "15")) ?? 1500,
      doc_terms: s(formData, "doc_terms"),
      doc_footer: s(formData, "doc_footer"),
    })
    .eq("id", profile.workshop_id);

  if (error) redirect(`/contractor/settings?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/contractor/settings");
  redirect("/contractor/settings?saved=1");
}

/**
 * Upload the partner's logo. The file arrives base64-encoded through the form (the same
 * ferry the machine-photo and checklist-photo flows use, so there is one upload story in
 * the codebase rather than three), is written under `{workshop_id}/…` in the
 * `partner-branding` bucket, and the object key is stored on the workshop row.
 *
 * The service client does the write. The bucket's own policy (0382) already restricts a
 * partner to their own prefix, but this action derives the prefix from the SESSION's
 * workshop id rather than anything the form said — so the path cannot be steered.
 */
export async function uploadPartnerLogo(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  if (!profile.workshop_id) redirect("/contractor?error=no-workshop");

  const dataUrl = String(formData.get("logo") ?? "");
  const match = /^data:(image\/(png|jpeg|webp|svg\+xml));base64,(.+)$/.exec(dataUrl);
  if (!match) redirect("/contractor/settings?error=logo-format");

  const [, contentType, , b64] = match;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.byteLength > 2_000_000) redirect("/contractor/settings?error=logo-too-big");

  const ext = contentType === "image/svg+xml" ? "svg" : contentType.split("/")[1];
  const path = `${profile.workshop_id}/logo-${Date.now()}.${ext}`;

  const service = createServiceClient();
  const { error } = await service.storage.from("partner-branding").upload(path, bytes, { contentType, upsert: true });
  if (error) redirect(`/contractor/settings?error=${encodeURIComponent(error.message)}`);

  const supabase = await createClient();
  await supabase.from("workshops").update({ logo_path: path }).eq("id", profile.workshop_id);
  revalidatePath("/contractor/settings");
  redirect("/contractor/settings?saved=1");
}

/** Drop the logo back to the wordmark. The stored object is left for the storage sweep. */
export async function removePartnerLogo() {
  const profile = await requireRole(["workshop"]);
  if (!profile.workshop_id) redirect("/contractor?error=no-workshop");
  const supabase = await createClient();
  await supabase.from("workshops").update({ logo_path: null }).eq("id", profile.workshop_id);
  revalidatePath("/contractor/settings");
  redirect("/contractor/settings?saved=1");
}

/**
 * How this partner's documents are laid out (G9).
 *
 * Goes through `update_document_layout`, which takes the workshop from the SESSION rather
 * than from an argument — so there is no id to tamper with and a partner cannot restyle
 * somebody else's documents. It merges rather than replaces, so a screen that offers
 * fifteen settings cannot wipe a sixteenth added later.
 *
 * Checkboxes are the awkward part of an HTML form: an unticked box posts nothing at all,
 * which is indistinguishable from "not offered". Every switch is therefore sent
 * explicitly as true or false from the known list, so unticking one actually turns it off
 * instead of silently falling back to the default.
 */
export async function updateDocumentLayout(formData: FormData) {
  await requireRole(["workshop"]);

  const patch: Record<string, unknown> = {};
  for (const key of LAYOUT_SWITCHES) patch[key] = formData.get(key) != null;

  for (const key of [
    "quote_title", "invoice_title", "credit_title", "debit_title",
    "bill_to_label", "items_label", "total_label", "thanks_text",
  ]) {
    patch[key] = String(formData.get(key) ?? "").trim();
  }

  const density = String(formData.get("density") ?? "comfortable");
  patch.density = density === "compact" ? "compact" : "comfortable";
  const accent = String(formData.get("accent_style") ?? "band");
  patch.accent_style = accent === "line" || accent === "plain" ? accent : "band";

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_document_layout", { p_patch: patch });
  if (error) redirect(`/contractor/settings?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/contractor/settings");
  revalidatePath("/documents");
  redirect("/contractor/settings?layout=1");
}
