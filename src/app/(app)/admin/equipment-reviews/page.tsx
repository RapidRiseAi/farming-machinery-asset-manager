import Link from "next/link";

import { requireRole } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { typeLabel } from "@/lib/machine-options";
import { createClient } from "@/lib/supabase/server";
import { must, mustAll } from "@/lib/supabase/must";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { decideEquipmentReview } from "./actions";

/**
 * Unusual asset classifications to look at (20261114090100). Internal, English-only like the
 * rest of the Rapid Rise console. An answer is a record for the conversation with the
 * customer: it changes no profile and no bill. Moving an asset that should be a full fleet
 * space is the customer's conversion, previewed and accepted by them.
 */
export const dynamic = "force-dynamic";

type Review = {
  id: string;
  farm_id: string;
  machine_id: string;
  source: string;
  reason: string;
  status: string;
  requested_at: string;
  decision_note: string | null;
};

export default async function EquipmentReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireRole(["rr_admin"]);
  const sp = await searchParams;
  const supabase = await createClient();
  const reviews = (must(
    await supabase
      .from("asset_classification_reviews")
      .select("id, farm_id, machine_id, source, reason, status, requested_at, decision_note")
      .order("requested_at", { ascending: false })
      .limit(200),
    "admin-equipment-reviews:list",
  ) ?? []) as Review[];
  const machineIds = [...new Set(reviews.map((r) => r.machine_id))];
  const farmIds = [...new Set(reviews.map((r) => r.farm_id))];
  const results = await Promise.all([
    supabase.from("machines").select("id, name, type, profile, make, model").in("id", machineIds.length ? machineIds : ["00000000-0000-0000-0000-000000000000"]),
    supabase.from("farms").select("id, name").in("id", farmIds.length ? farmIds : ["00000000-0000-0000-0000-000000000000"]),
  ]);
  mustAll(results, "admin-equipment-reviews:names");
  const machines = new Map(((results[0].data ?? []) as { id: string; name: string; type: string; profile: string; make: string | null; model: string | null }[]).map((m) => [m.id, m]));
  const farms = new Map(((results[1].data ?? []) as { id: string; name: string }[]).map((f) => [f.id, f.name]));
  const open = reviews.filter((r) => r.status === "open");
  const closed = reviews.filter((r) => r.status !== "open");

  const row = (r: Review) => {
    const m = machines.get(r.machine_id);
    return (
      <li key={r.id} className="flex flex-col gap-2 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/machines/${r.machine_id}`} className="font-medium text-brand-ink underline-offset-2 hover:underline">
            {m?.name ?? r.machine_id}
          </Link>
          <span className="text-sm text-sand-600">{farms.get(r.farm_id) ?? r.farm_id}</span>
          {m ? <Badge tone="neutral">{typeLabel(m.type, "en")}</Badge> : null}
          {m ? <Badge tone={m.profile === "equipment" ? "info" : "neutral"}>{m.profile === "equipment" ? "Support equipment" : "Full space"}</Badge> : null}
          <Badge tone={r.source === "automatic" ? "warning" : "neutral"}>{r.source === "automatic" ? "Opened by itself" : "Asked by the customer"}</Badge>
        </div>
        <p className="text-sm text-sand-800">{r.reason}</p>
        {m && (m.make || m.model) ? <p className="text-xs text-sand-500">{[m.make, m.model].filter(Boolean).join(" ")}</p> : null}
        {r.status === "open" ? (
          <form action={decideEquipmentReview} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={r.id} />
            <Field label="Note for the record (optional)" htmlFor={`note-${r.id}`}>
              <Textarea id={`note-${r.id}`} name="note" rows={2} maxLength={500} />
            </Field>
            <Field label="Answer" htmlFor={`status-${r.id}`}>
              <Select id={`status-${r.id}`} name="status" defaultValue="confirmed">
                <option value="confirmed">The classification is right</option>
                <option value="declined">It should be a full space: talk to the customer</option>
              </Select>
            </Field>
            <div>
              <SubmitButton variant="secondary" size="sm">Record the answer</SubmitButton>
            </div>
          </form>
        ) : (
          <p className="text-xs text-sand-500">
            {r.status === "confirmed" ? "Confirmed" : "Declined"}
            {r.decision_note ? `: ${r.decision_note}` : ""}
          </p>
        )}
      </li>
    );
  };

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("nav.adminEquipmentReviews", profile.lang)}
        lead="Unusual items on the support equipment profile, and customers asking about a classification. Nothing here bills or converts."
      />
      <Flash tone="error" message={errorMessage(sp.error, profile.lang)} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", profile.lang) : undefined} />
      <Card>
        <CardHeader><CardTitle as="h2">Open ({open.length})</CardTitle></CardHeader>
        {open.length === 0 ? <p className="text-sm text-sand-500">Nothing to look at.</p> : (
          <ul className="flex flex-col divide-y divide-sand-100">{open.map(row)}</ul>
        )}
      </Card>
      {closed.length > 0 ? (
        <Card>
          <CardHeader><CardTitle as="h2">Answered</CardTitle></CardHeader>
          <ul className="flex flex-col divide-y divide-sand-100">{closed.map(row)}</ul>
        </Card>
      ) : null}
    </PageContainer>
  );
}
