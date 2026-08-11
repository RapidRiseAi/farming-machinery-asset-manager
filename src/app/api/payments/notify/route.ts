import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { payfastConfig, verifyItn } from "@/lib/payments/payfast";
import { activeProvider } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PayFast's payment notification (G10).
 *
 * This is an UNAUTHENTICATED POST from the internet to a public URL — anyone can send one
 * claiming an invoice was paid. It is believed only when the signature recomputes, the
 * amount matches what we asked for, and PayFast itself confirms the payload when we hand
 * it back to them. See `lib/payments/payfast.ts` for why the third check is the one that
 * cannot be forged.
 *
 * Two behaviours here are deliberate and easy to get wrong:
 *
 *   ALWAYS 200. PayFast retries anything else, for hours. A rejected notification is
 *   still a notification we have finished with, so it is logged and acknowledged — the
 *   only thing a non-200 would achieve is the same forged payload arriving fifty more
 *   times.
 *
 *   The service role, not a session. There is no user here; the customer paying may not
 *   even have an account. RLS therefore cannot be the guard, so the guard is the
 *   verification above plus the unique index on (provider, provider_ref) from 0435, which
 *   is what stops a retried notification crediting the same invoice twice.
 */
export async function POST(request: Request) {
  if (activeProvider() !== "payfast") {
    return NextResponse.json({ ok: false, reason: "payments-off" }, { status: 200 });
  }
  const cfg = payfastConfig();
  if (!cfg) return NextResponse.json({ ok: false, reason: "not-configured" }, { status: 200 });

  const raw = await request.text();
  const body = new URLSearchParams(raw);
  const svc = createServiceClient();

  // What we believe is owed on the document this notification names. Looked up here so
  // the amount check compares against OUR record, never against the callback's own claim.
  const expected = async (documentId: string): Promise<number | null> => {
    const { data } = await svc
      .from("partner_documents")
      .select("total_cents, amount_paid_cents, kind, status")
      .eq("id", documentId)
      .is("deleted_at", null)
      .maybeSingle();
    const d = data as { total_cents: number; amount_paid_cents: number; kind: string; status: string } | null;
    if (!d || d.kind !== "invoice") return null;
    return Math.max(0, d.total_cents - (d.amount_paid_cents ?? 0));
  };

  const result = await verifyItn(cfg, body, expected);
  if (!result.ok) {
    console.warn("[payfast] rejected notification:", result.reason);
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 200 });
  }

  const { data: docData } = await svc
    .from("partner_documents")
    .select("id, farm_id, number")
    .eq("id", result.paymentId)
    .maybeSingle();
  const doc = docData as { id: string; farm_id: string | null; number: string } | null;
  if (!doc) return NextResponse.json({ ok: false, reason: "no-document" }, { status: 200 });

  const { error } = await svc.from("partner_payments").insert({
    farm_id: doc.farm_id,
    document_id: doc.id,
    amount_cents: result.amountCents,
    paid_on: new Date().toISOString().slice(0, 10),
    method: "card",
    reference: doc.number,
    provider: "payfast",
    provider_ref: result.providerRef,
  });

  if (error) {
    // A duplicate is the expected case, not a failure: PayFast retries, and the unique
    // index is what makes that harmless. Anything else is worth seeing in the logs.
    const duplicate = error.code === "23505";
    if (!duplicate) console.error("[payfast] could not record payment:", error.message);
    return NextResponse.json({ ok: duplicate, reason: duplicate ? "already-recorded" : error.message }, { status: 200 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
