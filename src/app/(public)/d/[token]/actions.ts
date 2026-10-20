"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/service";
import { captureError } from "@/lib/observability";

/**
 * What a customer can do from the emailed link, without an account.
 *
 * The token is the ONLY credential, exactly as on the public QR page: it is unguessable,
 * it is never exposed to anon SQL, and every read and write here runs through the service
 * client after the token has been resolved to a row. `anon` still has zero database
 * access, that property has held since 0102 and is not weakened by this.
 *
 * Deliberately narrow. A holder of the link may accept a quote, decline it, or say they
 * have paid. They cannot change an amount, see another document, or reach anything else.
 */

async function docByToken(token: string) {
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("partner_documents")
    .select("id, kind, status, workshop_id, farm_id, number, total_cents")
    .eq("public_token", token)
    .is("deleted_at", null)
    .maybeSingle();
  // A failed read is not an unknown link: sending a customer with a good link to "not
  // found" told them their invoice did not exist.
  if (error) {
    captureError(error, { where: "public-document:read" });
    redirect(`/d/${token}?error=try-again`);
  }
  return data as
    | { id: string; kind: string; status: string; workshop_id: string; farm_id: string | null; number: string; total_cents: number }
    | null;
}

/**
 * Accept a quote from the link.
 *
 * Acceptance used to be a status column and a timestamp, thinner evidence than the
 * paper book it replaced, and nothing a partner could produce if the customer later said
 * they never agreed. Now the person types their name, and we record that they did it from
 * the link rather than inside the app.
 */
export async function acceptFromLink(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("accepted_by") ?? "").trim();
  const doc = await docByToken(token);
  if (!doc) redirect("/d/unknown");
  if (doc.kind !== "quote" || doc.status !== "sent") redirect(`/d/${token}?error=closed`);
  if (name.length < 2) redirect(`/d/${token}?error=name`);

  const svc = createServiceClient();
  // Only while it is still "sent": two taps, two tabs or a retry must not accept twice or
  // tell the partner twice. The row comes back only when this request changed it.
  const { data: changed, error } = await svc
    .from("partner_documents")
    .update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
      accepted_by_name: name.slice(0, 120),
      accepted_via: "link",
      updated_at: new Date().toISOString(),
    })
    .eq("id", doc.id)
    .eq("status", "sent")
    .select("id");
  if (error) {
    captureError(error, { where: "public-document:accept" });
    redirect(`/d/${token}?error=try-again`);
  }
  if (!changed?.length) redirect(await settledHref(token, "accepted"));

  // Tell the partner without waiting for them to look: this is the moment they can start.
  await notifyPartner(svc, "quote_accepted_partner", doc, { amount: doc.total_cents, by: name });

  revalidatePath(`/d/${token}`);
  redirect(`/d/${token}?accepted=1`);
}

export async function declineFromLink(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500) || null;
  const doc = await docByToken(token);
  if (!doc) redirect("/d/unknown");
  if (doc.kind !== "quote" || doc.status !== "sent") redirect(`/d/${token}?error=closed`);

  const svc = createServiceClient();
  const { data: changed, error } = await svc
    .from("partner_documents")
    .update({
      status: "declined",
      declined_at: new Date().toISOString(),
      declined_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", doc.id)
    .eq("status", "sent")
    .select("id");
  if (error) {
    captureError(error, { where: "public-document:decline" });
    redirect(`/d/${token}?error=try-again`);
  }
  if (!changed?.length) redirect(await settledHref(token, "declined"));

  await notifyPartner(svc, "quote_declined_partner", doc, { reason });

  revalidatePath(`/d/${token}`);
  redirect(`/d/${token}?declined=1`);
}

/**
 * "I have paid this."
 *
 * Deliberately NOT a payment: the customer cannot write money into the partner's books
 * from a link they were emailed. It tells the partner to go and look, with the reference
 * the customer used, which is the piece they need to match it in their bank statement.
 */
export async function notifyPaidFromLink(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const reference = String(formData.get("reference") ?? "").trim().slice(0, 120) || null;
  const doc = await docByToken(token);
  if (!doc) redirect("/d/unknown");
  if (doc.kind !== "invoice") redirect(`/d/${token}?error=closed`);

  const svc = createServiceClient();
  // Once per ten minutes per invoice: a customer who taps again, or reloads and taps, is
  // thanked again, but the partner is told once.
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: stamped, error } = await svc
    .from("partner_documents")
    .update({ payment_claimed_at: new Date().toISOString() })
    .eq("id", doc.id)
    .or(`payment_claimed_at.is.null,payment_claimed_at.lt.${cutoff}`)
    .select("id");
  if (error) {
    captureError(error, { where: "public-document:paid" });
    redirect(`/d/${token}?error=try-again`);
  }
  if (stamped?.length) {
    await notifyPartner(svc, "payment_claimed_partner", doc, { reference, amount: doc.total_cents });
  }

  redirect(`/d/${token}?told=1`);
}

type LinkDoc = { id: string; workshop_id: string; farm_id: string | null; number: string };

/**
 * Tell the partner. A failure here is reported, not shown: the customer's answer is saved,
 * and telling them otherwise would make them do it again.
 */
async function notifyPartner(
  svc: ReturnType<typeof createServiceClient>,
  template: string,
  doc: LinkDoc,
  extra: Record<string, unknown>,
) {
  const { error } = await svc.rpc("notify_workshop_document", {
    p_workshop: doc.workshop_id,
    p_farm: doc.farm_id,
    p_template: template,
    p_payload: { document_id: doc.id, number: doc.number, ...extra },
  });
  if (error) captureError(error, { where: `public-document:notify:${template}` });
}

/**
 * Where a repeat goes when its quote is no longer "sent": to the same thank-you if the
 * first attempt already did what this one asked, otherwise "this quote is closed".
 */
async function settledHref(token: string, wanted: "accepted" | "declined"): Promise<string> {
  const now = await docByToken(token);
  return now?.status === wanted ? `/d/${token}?${wanted}=1` : `/d/${token}?error=closed`;
}
