import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { num, shortDate } from "@/lib/format";
import { aiResult } from "@/lib/ai-usage/results";
import { Card, CardTitle } from "@/components/ui/card";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { acceptHeldPrice, resolveAiHealthEvent, setAiMargin, setManualFxRate } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Rapid Rise's view of AI and voice (docs/AI_USAGE.md): what the providers charged this
 * month against what farms were billed, by farm; the margin and exchange rate behind every
 * bill; the prices in force; and anything the nightly job flagged: a provider failing,
 * Gateway credit low, or a price or rate it would not take without a person. Platform
 * admins only; the tables' row security says the same.
 */

type FarmRow = { farm_id: string; name: string; cost_usd: number; billed_cents: number; calls: number; failed: number };
type MonthSummary = { platform_cost_usd: number; billed_cents: number; farms: FarmRow[] };
type HealthRow = { id: string; kind: string; subject: string; detail: Record<string, unknown>; created_at: string };
type PriceRow = { model: string; unit: string; usd_per_unit: number; source: string; effective_from: string };

export default async function AdminAiPage({ searchParams }: { searchParams: Promise<{ ai?: string }> }) {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const result = aiResult(sp.ai);
  const supabase = await createClient();
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date()).slice(0, 7) + "-01";

  // The month is summed in the database (ai_admin_month), so it is whole however many
  // rows it has; this page never pulls ledger rows itself.
  const [settingsRes, fxRes, summaryRes, healthRes, pricesRes] = await Promise.all([
    supabase.from("billing_settings").select("ai_margin_bps, ai_default_limit_cents, ai_trial_limit_cents").eq("singleton", true).maybeSingle(),
    supabase.from("fx_rates").select("day, usd_zar, source").order("day", { ascending: false }).limit(1).maybeSingle(),
    supabase.rpc("ai_admin_month", { p_month: month }),
    supabase.from("ai_health_events").select("id, kind, subject, detail, created_at").is("resolved_at", null).order("created_at", { ascending: false }),
    supabase.from("ai_prices").select("model, unit, usd_per_unit, source, effective_from").order("effective_from", { ascending: false }).limit(500),
  ]);
  const marginBps = Number(settingsRes.data?.ai_margin_bps ?? 3000);
  const fx = fxRes.data ? Number(fxRes.data.usd_zar) : null;
  const summary = (summaryRes.data ?? { platform_cost_usd: 0, billed_cents: 0, farms: [] }) as MonthSummary;
  const farms = summary.farms ?? [];
  const health = (healthRes.data ?? []) as HealthRow[];

  // Latest price per model and unit.
  const prices = new Map<string, PriceRow>();
  for (const row of (pricesRes.data ?? []) as PriceRow[]) {
    const key = `${row.model} ${row.unit}`;
    if (!prices.has(key)) prices.set(key, row);
  }

  // Provider cost to the platform (ours and Rapid Rise support) against billed (platform only).
  const costUsd = Number(summary.platform_cost_usd);
  const billed = Number(summary.billed_cents);
  const costCents = fx ? costUsd * fx * 100 : null;

  return (
    <PageContainer size="wide">
      <PageHeader title={t("aiUsage.admin.title", locale)} lead={t("aiUsage.admin.lead", locale)} locale={locale} />
      {result ? <Flash tone={result.tone} message={t(`aiUsage.result.${result.code}`, locale)} clearParams={["ai"]} /> : null}

      <Card>
        <CardTitle>{t("aiUsage.admin.thisMonth", locale)}</CardTitle>
        <StatGrid className="mt-4">
          <Stat label={t("aiUsage.admin.providerCost", locale)} value={`$${num(costUsd, 2)}`} valueKind="text" />
          <Stat label={t("aiUsage.admin.providerCostZar", locale)} value={costCents === null ? "-" : rands(Math.round(costCents))} valueKind="text" />
          <Stat label={t("aiUsage.admin.billed", locale)} value={rands(Math.round(billed))} valueKind="text" />
          <Stat label={t("aiUsage.admin.margin", locale)} value={costCents === null ? "-" : rands(Math.round(billed - costCents))} valueKind="text" />
        </StatGrid>
        <p className="mt-3 text-xs leading-5 text-ink-muted">{t("aiUsage.admin.costNote", locale)}</p>
      </Card>

      <Card>
        <CardTitle>{t("aiUsage.admin.settingsTitle", locale)}</CardTitle>
        <dl className="mt-3 divide-y divide-edge-soft">
          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <dt className="text-sm text-sand-800">{t("aiUsage.admin.marginSetting", locale)}</dt>
            <dd className="text-sm font-medium tabular-nums">{num(marginBps / 100, 0)}%</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <dt className="text-sm text-sand-800">{t("aiUsage.admin.fxSetting", locale)}</dt>
            <dd className="text-sm font-medium tabular-nums">
              {fx === null ? "-" : `R${num(fx, 4)}`} {fxRes.data ? `(${shortDate(String(fxRes.data.day), locale)}, ${String(fxRes.data.source)})` : ""}
            </dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <DialogForm trigger={t("aiUsage.admin.changeMargin", locale)} title={t("aiUsage.admin.marginSetting", locale)}
            description={t("aiUsage.admin.marginHelp", locale)} closeLabel={t("ui.close", locale)} triggerVariant="secondary">
            <form action={setAiMargin}>
              <DialogFields>
                <Field label={t("aiUsage.admin.marginField", locale)} htmlFor="ai-margin">
                  <Input id="ai-margin" name="percent" inputMode="decimal" required defaultValue={String(marginBps / 100)} />
                </Field>
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <SubmitButton>{t("common.save", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
          <DialogForm trigger={t("aiUsage.admin.setFx", locale)} title={t("aiUsage.admin.fxSetting", locale)}
            description={t("aiUsage.admin.fxHelp", locale)} closeLabel={t("ui.close", locale)} triggerVariant="secondary">
            <form action={setManualFxRate}>
              <DialogFields>
                <Field label={t("aiUsage.admin.fxField", locale)} htmlFor="ai-fx">
                  <Input id="ai-fx" name="rate" inputMode="decimal" required defaultValue={fx === null ? "" : String(fx)} />
                </Field>
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <SubmitButton>{t("common.save", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        </div>
      </Card>

      <Card>
        <CardTitle>{t("aiUsage.admin.healthTitle", locale)}</CardTitle>
        {health.length === 0 ? (
          <p className="mt-2 text-sm text-sand-600">{t("aiUsage.admin.healthClear", locale)}</p>
        ) : (
          <ul className="mt-3 divide-y divide-edge-soft">
            {health.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-sand-900">
                    <Badge tone="warning">{t(`aiUsage.admin.kind.${event.kind}`, locale)}</Badge> {event.subject}
                  </p>
                  <p className="break-words font-mono text-xs text-ink-muted">{JSON.stringify(event.detail)}</p>
                </div>
                <div className="flex gap-2">
                  {event.kind === "price_pending" ? (
                    <form action={acceptHeldPrice}>
                      <input type="hidden" name="id" value={event.id} />
                      <SubmitButton size="sm">{t("aiUsage.admin.acceptPrice", locale)}</SubmitButton>
                    </form>
                  ) : null}
                  <form action={resolveAiHealthEvent}>
                    <input type="hidden" name="id" value={event.id} />
                    <SubmitButton size="sm" variant="secondary">{t("aiUsage.admin.resolve", locale)}</SubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardTitle>{t("aiUsage.admin.farmsTitle", locale)}</CardTitle>
        {summaryRes.error ? (
          <p className="mt-2 text-sm text-sand-600">{t("aiUsage.unavailable", locale)}</p>
        ) : farms.length === 0 ? (
          <p className="mt-2 text-sm text-sand-600">{t("aiUsage.admin.noUse", locale)}</p>
        ) : (
          <Table stacked className="mt-3">
            <Thead>
              <Tr>
                <Th>{t("aiUsage.admin.farm", locale)}</Th>
                <Th>{t("aiUsage.admin.calls", locale)}</Th>
                <Th>{t("aiUsage.admin.failedCalls", locale)}</Th>
                <Th>{t("aiUsage.admin.providerCost", locale)}</Th>
                <Th>{t("aiUsage.admin.billed", locale)}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {farms.map((farm) => (
                <Tr key={farm.farm_id}>
                  <Td label={t("aiUsage.admin.farm", locale)}>{farm.name ?? farm.farm_id}</Td>
                  <Td label={t("aiUsage.admin.calls", locale)}>{num(Number(farm.calls), 0)}</Td>
                  <Td label={t("aiUsage.admin.failedCalls", locale)}>{num(Number(farm.failed), 0)}</Td>
                  <Td label={t("aiUsage.admin.providerCost", locale)}>${num(Number(farm.cost_usd), 4)}</Td>
                  <Td label={t("aiUsage.admin.billed", locale)}>{rands(Math.round(Number(farm.billed_cents)))}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardTitle>{t("aiUsage.admin.pricesTitle", locale)}</CardTitle>
        <Table stacked className="mt-3">
          <Thead>
            <Tr>
              <Th>{t("aiUsage.admin.model", locale)}</Th>
              <Th>{t("aiUsage.admin.unit", locale)}</Th>
              <Th>{t("aiUsage.admin.price", locale)}</Th>
              <Th>{t("aiUsage.admin.source", locale)}</Th>
            </Tr>
          </Thead>
          <Tbody>
            {[...prices.values()].map((price) => (
              <Tr key={`${price.model} ${price.unit}`}>
                <Td label={t("aiUsage.admin.model", locale)}>{price.model}</Td>
                <Td label={t("aiUsage.admin.unit", locale)}>{price.unit}</Td>
                <Td label={t("aiUsage.admin.price", locale)}>${Number(price.usd_per_unit).toPrecision(4)}</Td>
                <Td label={t("aiUsage.admin.source", locale)}>{price.source}, {shortDate(price.effective_from, locale)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>
    </PageContainer>
  );
}
