import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { readAll } from "@/lib/supabase/read-all";
import { mustAll } from "@/lib/supabase/must";
import { t } from "@/lib/i18n";
import { PLANS } from "@/lib/entitlements";
import { adminOnboardCustomer, createFarm } from "./actions";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { MIN_BILLED_SLOTS, PLAN_PRICING } from "@/lib/entitlements";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { SelectField, TextField } from "@/components/ui/field";
import { Badge, StatusBadge, type StatusLook } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { DateText } from "@/components/ui/date-text";
import { EmptyState } from "@/components/ui/empty-state";
import { PlusIcon } from "@/components/ui/icons";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { num } from "@/lib/format";

type FarmRow = { id: string; name: string; plan: string; status: string; created_at: string; is_test: boolean };

const planLabel = (p: string): string => t(`plan.${p}`, "en");

// Status is shape + word + colour, never colour alone.
const statusLook = (s: string): StatusLook =>
  s === "active"
    ? { tone: "ok", shape: "dot" }
    : s === "trial"
      ? { tone: "info", shape: "half" }
      : s === "suspended"
        ? { tone: "warning", shape: "triangle" }
        : { tone: "danger", shape: "square" };
const statusWord = (s: string): string => {
  const words = s.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export default async function AdminFarmsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string }>;
}) {
  // The profile was discarded here, so this page had no locale to translate with.
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  // Counted by the database, one row per farm: counting rows here stopped at the API's
  // thousandth machine, user or job card across the whole platform (20261013090000).
  type Activity = { farm_id: string; machines: number; active_users: number; jobs_this_month: number; last_activity: string | null };
  const results = await Promise.all([
    readAll(() => supabase.from("farms").select("id, name, plan, status, created_at, is_test").order("created_at", { ascending: false })),
    readAll<Activity>(() => supabase.rpc("admin_farm_activity", { p_month_start: monthStart }), { key: "farm_id" }),
  ]);
  // A failed read showed "No farms yet", or every farm with 0 machines and no activity.
  mustAll(results, "admin-farms:list");
  const [{ data: fData }, { data: aData }] = results;
  const farms = (fData as FarmRow[] | null) ?? [];
  // Test farms (the click-through farm the automatic checks sign in to) are listed, so they
  // can be opened, but are not customers and stay out of the count (20261014110000).
  const customers = farms.filter((f) => !f.is_test).length;
  const tests = farms.length - customers;

  const activity = new Map(((aData as Activity[] | null) ?? []).map((a) => [a.farm_id, a]));
  const machinesBy = new Map([...activity].map(([id, a]) => [id, a.machines]));
  const activeUsersBy = new Map([...activity].map(([id, a]) => [id, a.active_users]));
  const jobsThisMonthBy = new Map([...activity].map(([id, a]) => [id, a.jobs_this_month]));
  const lastActivityBy = new Map(
    [...activity].flatMap(([id, a]) => (a.last_activity ? [[id, a.last_activity] as const] : [])),
  );
  const daysAgo = (iso?: string) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);

  const newFarm = (
    <DialogForm
      trigger="New farm"
      triggerIcon={<PlusIcon />}
      title="New farm"
      description="The farm starts empty. Invite its owner from the farm's page once it exists."
      closeLabel={t("ui.close", "en")}
      size="md"
    >
      <form action={createFarm}>
        <DialogFields columns={1}>
          <TextField name="name" id="farm-name" label="Farm name" required autoComplete="off" />
          <SelectField name="plan" id="farm-plan" label="Plan" defaultValue="essential">
            {PLANS.map((p) => (
              <option key={p} value={p}>{planLabel(p)}</option>
            ))}
          </SelectField>
        </DialogFields>
        <DialogActions cancelLabel={t("common.cancel", "en")}>
          <SubmitButton>Create farm</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  // A quoted customer, set up in one step: farm, pending subscription and first invoice
  // (no trial), and the owner's invitation (20261105100000). Plans with a list price only.
  const onboard = (
    <DialogForm
      trigger="Set up a customer"
      triggerIcon={<PlusIcon />}
      title="Set up a quoted customer"
      description={`Creates the farm, raises its first invoice and invites the owner. No trial: they sign in, pay by card or EFT, then use FleetWise. At least ${MIN_BILLED_SLOTS} vehicle slots.`}
      closeLabel={t("ui.close", "en")}
      size="md"
    >
      <form action={adminOnboardCustomer}>
        <RequestIdInput action="admin:onboard" />
        <DialogFields columns={1}>
          <TextField name="name" id="onboard-name" label="Farm or business name" required autoComplete="off" />
          <SelectField name="plan" id="onboard-plan" label="Plan" defaultValue="essential">
            {PLANS.filter((p) => PLAN_PRICING[p].perVehicleMonthlyCents != null).map((p) => (
              <option key={p} value={p}>{planLabel(p)}</option>
            ))}
          </SelectField>
          <SelectField name="billing_period" id="onboard-period" label="Billing" defaultValue="monthly">
            <option value="monthly">Monthly</option>
            <option value="annual">Yearly (ten months)</option>
          </SelectField>
          <TextField name="slots" id="onboard-slots" label="Vehicle slots" type="number" inputMode="numeric" min={MIN_BILLED_SLOTS} defaultValue={String(MIN_BILLED_SLOTS)} required />
          <TextField name="owner_name" id="onboard-owner-name" label="Owner's name" required autoComplete="off" />
          <TextField name="owner_email" id="onboard-owner-email" label="Owner's email" type="email" required autoComplete="off" />
          <SelectField name="language" id="onboard-language" label="Owner's language" defaultValue="af">
            <option value="af">Afrikaans</option>
            <option value="en">English</option>
          </SelectField>
        </DialogFields>
        <DialogActions cancelLabel={t("common.cancel", "en")}>
          <SubmitButton>Set up and invite</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Farms"
        meta={farms.length > 0 ? `${num(customers)} farm${customers === 1 ? "" : "s"}${tests > 0 ? `, plus ${num(tests)} test` : ""}` : undefined}
        lead="Every farm on FleetWise. Open one to change its plan or status, or to help it in support mode."
        actions={<div className="flex flex-wrap gap-2">{onboard}{newFarm}</div>}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.created ? t("admin.farmCreated", locale) : undefined} />
      <Link className="underline" href="/admin/driver-integrations">{t("driving.integrations",locale)}</Link>

      {farms.length === 0 ? (
        <EmptyState title="No farms yet" hint="Create the first one with New farm." />
      ) : (
        <Card flush>
          <Table>
            <Thead>
              <Tr>
                <Th>Farm</Th><Th>Plan</Th><Th>Status</Th>
                <Th className="text-right">Machines</Th>
                <Th className="text-right">Active users</Th>
                <Th className="text-right">Jobs (mo)</Th>
                <Th className="text-right">Last activity</Th>
              </Tr>
            </Thead>
            <Tbody>
              {farms.map((f) => {
                const last = lastActivityBy.get(f.id);
                const d = daysAgo(last);
                const stale = d != null && d >= 14;
                const look = statusLook(f.status);
                return (
                  <Tr key={f.id}>
                    <Td className="font-medium">
                      <Link href={`/admin/farms/${f.id}`} className="focus-ring rounded text-brand-ink hover:underline">{f.name}</Link>
                      {f.is_test ? <Badge className="ml-2" title="A test farm: left out of the totals">Test</Badge> : null}
                    </Td>
                    <Td className="text-sand-600">{planLabel(f.plan)}</Td>
                    <Td><StatusBadge tone={look.tone} shape={look.shape} label={statusWord(f.status)} /></Td>
                    <Td className="text-right tnum">{num(machinesBy.get(f.id) ?? 0)}</Td>
                    <Td className="text-right tnum">{num(activeUsersBy.get(f.id) ?? 0)}</Td>
                    <Td className="text-right tnum">{num(jobsThisMonthBy.get(f.id) ?? 0)}</Td>
                    <Td className={`text-right tnum ${stale ? "font-medium text-status-overdue" : "text-sand-600"}`}>
                      {last ? <DateText value={last} locale="en" format="relative" /> : "-"}
                      {stale ? <span className="block text-xs">Quiet for 2 weeks</span> : null}
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        </Card>
      )}
    </PageContainer>
  );
}
