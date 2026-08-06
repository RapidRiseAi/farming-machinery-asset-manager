import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop, homePathFor, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import { workshopPlanAllows } from "@/lib/contractor-plan";
import { awaitsCustomer, balanceDueCents, type DocKind, type DocStatus } from "@/lib/partner-docs";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { DocStatus as DocStatusBadge } from "@/components/ui/status";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { AllClear, GetStarted } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { FilterBar, type FilterGroup } from "@/components/ui/filter-bar";
import { NewDocument } from "@/components/partner/new-document";
import { UploadDocument } from "@/components/partner/upload-document";

/**
 * Quotes and invoices — one route, two audiences (F14c/F14d).
 *
 * A PARTNER sees what they have issued, across every farm they serve, with what is still
 * a draft and what is still unpaid at the top. A FARMER sees what has been sent to them,
 * with the ones waiting on a decision first. Neither list is filtered in the query by who
 * is asking: `app.partner_doc_visible` (0381) already decides that, which is why two
 * contractors on the same farm never see each other's pricing.
 *
 * Operators never reach this screen — the same policy excludes them, and the nav does not
 * offer it.
 */

type Row = {
  id: string;
  kind: DocKind;
  status: DocStatus;
  number: string;
  subject: string | null;
  issue_date: string;
  due_date: string | null;
  total_cents: number;
  amount_paid_cents: number;
  farm_id: string;
  workshop_id: string;
  machine_id: string | null;
};

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string; error?: string; deleted?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role === "operator") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.lang;
  const sp = await searchParams;
  const isPartner = profile.role === "workshop";
  const isFarmSide = profile.role === "owner" || profile.role === "manager";

  const supabase = await createClient();
  const { workshop, plan } = await currentWorkshop(profile);
  const canBuild = isPartner && plan != null && workshopPlanAllows(plan, "build_documents");

  let query = supabase
    .from("partner_documents")
    .select("id, kind, status, number, subject, issue_date, due_date, total_cents, amount_paid_cents, farm_id, workshop_id, machine_id")
    .is("deleted_at", null)
    .order("issue_date", { ascending: false })
    .limit(200);

  // A farm user is scoped to the site they are currently looking at (F7); a partner is
  // scoped by RLS to the farms they are linked to, which is the whole point of their view.
  const farmId = isPartner ? null : await currentFarmId(profile);
  if (farmId) query = query.eq("farm_id", farmId);
  if (sp.kind === "quote" || sp.kind === "invoice") query = query.eq("kind", sp.kind);
  if (sp.status) query = query.eq("status", sp.status);

  const { data } = await query;
  const rows = (data ?? []) as Row[];

  // Names for the other side of each document.
  const farmIds = [...new Set(rows.map((r) => r.farm_id))];
  const shopIds = [...new Set(rows.map((r) => r.workshop_id))];
  const machineIds = [...new Set(rows.map((r) => r.machine_id).filter(Boolean))] as string[];

  const [farmsRes, shopsRes, machinesRes] = await Promise.all([
    farmIds.length ? supabase.from("farms").select("id, name").in("id", farmIds) : Promise.resolve({ data: [] }),
    shopIds.length ? supabase.from("workshops").select("id, name, trading_name").in("id", shopIds) : Promise.resolve({ data: [] }),
    machineIds.length ? supabase.from("machines").select("id, name").in("id", machineIds) : Promise.resolve({ data: [] }),
  ]);
  const farmName = new Map((farmsRes.data ?? []).map((f: { id: string; name: string }) => [f.id, f.name]));
  const shopName = new Map(
    (shopsRes.data ?? []).map((w: { id: string; name: string; trading_name?: string | null }) => [w.id, w.trading_name || w.name]),
  );
  const machineName = new Map((machinesRes.data ?? []).map((m: { id: string; name: string }) => [m.id, m.name]));

  // Who the "upload a document I made elsewhere" form can name on the other side: for a
  // partner, the farms linked to them; for a farm, the contractors linked to the farm.
  const { data: linkData } = await supabase
    .from("workshop_links")
    .select("farm_id, workshop_id, farms(id, name), workshops(id, name, trading_name)")
    .eq("status", "active")
    .is("deleted_at", null);
  // PostgREST types an embedded relation as an array even when the FK makes it at most
  // one row, so normalise both sides before use.
  const links = ((linkData ?? []) as unknown as {
    farm_id: string;
    workshop_id: string;
    farms: { id: string; name: string } | { id: string; name: string }[] | null;
    workshops: { id: string; name: string; trading_name: string | null } | { id: string; name: string; trading_name: string | null }[] | null;
  }[]).map((l) => ({
    farm_id: l.farm_id,
    workshop_id: l.workshop_id,
    farms: Array.isArray(l.farms) ? (l.farms[0] ?? null) : l.farms,
    workshops: Array.isArray(l.workshops) ? (l.workshops[0] ?? null) : l.workshops,
  }));
  const parties = isPartner
    ? [...new Map(links.filter((l) => l.farms).map((l) => [l.farms!.id, { id: l.farms!.id, name: l.farms!.name }])).values()]
    : [
        ...new Map(
          links
            .filter((l) => l.workshops && (!farmId || l.farm_id === farmId))
            .map((l) => [l.workshops!.id, { id: l.workshops!.id, name: l.workshops!.trading_name || l.workshops!.name }]),
        ).values(),
      ];

  // What is actually outstanding, in money rather than in counts.
  const openInvoices = rows.filter((r) => r.kind === "invoice" && ["sent", "part_paid"].includes(r.status));
  const outstanding = openInvoices.reduce((sum, r) => sum + balanceDueCents(r), 0);
  const openQuotes = rows.filter((r) => r.kind === "quote" && r.status === "sent");
  const quoted = openQuotes.reduce((sum, r) => sum + r.total_cents, 0);
  const drafts = rows.filter((r) => r.status === "draft");

  // The rows that are waiting on somebody: the farmer's decision, or the farmer's money.
  const needsAttention = rows.filter((r) => (isPartner ? r.status === "draft" || awaitsCustomer(r) : awaitsCustomer(r)));
  const rest = rows.filter((r) => !needsAttention.includes(r));

  const filters: FilterGroup[] = [
    {
      paramName: "kind",
      label: t("doc.filterKind", locale),
      current: sp.kind,
      options: [
        { value: "quote", label: t("doc.kindQuote", locale) },
        { value: "invoice", label: t("doc.kindInvoice", locale) },
      ],
    },
    {
      paramName: "status",
      label: t("doc.filterStatus", locale),
      current: sp.status,
      options: (["draft", "sent", "accepted", "part_paid", "paid", "declined"] as DocStatus[]).map((v) => ({
        value: v,
        label: t(`docStatus.${v}`, locale),
      })),
    },
  ];
  const search = new URLSearchParams(
    Object.entries(sp).filter(([, v]) => typeof v === "string" && v !== "") as [string, string][],
  ).toString();

  function DocRow({ r }: { r: Row }) {
    const other = isPartner ? farmName.get(r.farm_id) : shopName.get(r.workshop_id);
    const due = r.kind === "invoice" ? balanceDueCents(r) : r.total_cents;
    return (
      <li>
        <Link
          href={`/documents/${r.id}`}
          className="focus-ring flex flex-col gap-1.5 rounded-xl border border-sand-200 bg-white p-3 hover:border-brand-300 hover:bg-brand-50/40"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={r.kind === "invoice" ? "brand" : "neutral"}>
              {t(r.kind === "invoice" ? "doc.kindInvoice" : "doc.kindQuote", locale)}
            </Badge>
            <span className="font-mono text-sm font-medium tabular-nums text-sand-700">{r.number}</span>
            <DocStatusBadge value={r.status} locale={locale} />
            <span className="ml-auto text-base font-semibold tabular-nums text-sand-900">{rands(due)}</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-sand-600">
            {other ? <span className="font-medium text-sand-800">{other}</span> : null}
            {r.machine_id && machineName.get(r.machine_id) ? <span>· {machineName.get(r.machine_id)}</span> : null}
            {r.subject ? <span className="min-w-0 truncate">· {r.subject}</span> : null}
          </div>
          <p className="text-xs text-sand-500">
            {shortDate(r.issue_date, locale)}
            {r.kind === "invoice" && r.amount_paid_cents > 0 && r.status !== "paid"
              ? ` · ${t("doc.paidSoFar", locale)} ${rands(r.amount_paid_cents)}`
              : null}
            {r.due_date ? ` · ${t(r.kind === "quote" ? "doc.validUntil" : "doc.dueBy", locale)} ${shortDate(r.due_date, locale)}` : null}
          </p>
        </Link>
      </li>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("doc.title", locale)}</h1>
        <PageInfoButton infoKey={isPartner ? "documentsPartner" : "documents"} locale={locale} />
        {isPartner ? <NewDocument locale={locale} canBuild={canBuild} /> : null}
      </div>
      <p className="text-sand-600">{t(isPartner ? "doc.leadPartner" : "doc.leadFarm", locale)}</p>

      <Flash tone="error" message={sp.error === "upgrade" ? t("doc.upgradeNeeded", locale) : sp.error} />
      <Flash tone="success" message={sp.deleted ? t("doc.draftDeleted", locale) : undefined} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={t("doc.outstanding", locale)} value={rands(outstanding)} tone={outstanding > 0 ? "due" : "ok"} />
        <Stat label={t("doc.awaitingDecision", locale)} value={rands(quoted)} />
        {isPartner ? <Stat label={t("doc.drafts", locale)} value={drafts.length} /> : null}
      </div>

      <FilterBar
        path="/documents"
        search={search}
        groups={filters}
        filtersLabel={t("filters.filters", locale)}
        clearLabel={t("filters.clearAll", locale)}
      />

      {rows.length === 0 ? (
        isPartner ? (
          <GetStarted title={t("doc.emptyPartnerTitle", locale)} hint={t("doc.emptyPartnerBody", locale)} />
        ) : (
          <AllClear title={t("doc.emptyFarmTitle", locale)} hint={t("doc.emptyFarmBody", locale)} />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {needsAttention.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t(isPartner ? "doc.needsYouPartner" : "doc.needsYouFarm", locale)}</CardTitle>
              </CardHeader>
              <ul className="flex flex-col gap-2">
                {needsAttention.map((r) => (
                  <DocRow key={r.id} r={r} />
                ))}
              </ul>
            </Card>
          ) : null}

          {rest.length > 0 ? (
            <Card>
              <CardHeader><CardTitle>{t("doc.everythingElse", locale)}</CardTitle></CardHeader>
              <ul className="flex flex-col gap-2">
                {rest.map((r) => (
                  <DocRow key={r.id} r={r} />
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      )}

      {isPartner || isFarmSide ? <UploadDocument locale={locale} parties={parties} isPartner={isPartner} /> : null}

      {isPartner && !canBuild ? (
        <Card>
          <CardHeader><CardTitle>{t("doc.upgradeTitle", locale)}</CardTitle></CardHeader>
          <p className="text-sm text-sand-600">{t("doc.upgradeBody", locale)}</p>
          <p className="mt-2 text-sm text-sand-500">{t("doc.upgradeKeep", locale)}</p>
          <Link href="/contractor/settings" className={`${buttonVariants({ variant: "secondary", size: "sm" })} mt-3`}>
            {t("partnerSettings.title", locale)}
          </Link>
        </Card>
      ) : null}
    </div>
  );
}
