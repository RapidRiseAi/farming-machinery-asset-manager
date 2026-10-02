import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { PLANS } from "@/lib/entitlements";
import { createFarm } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { SelectField, TextField } from "@/components/ui/field";
import { StatusBadge, type StatusLook } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { DateText } from "@/components/ui/date-text";
import { EmptyState } from "@/components/ui/empty-state";
import { PlusIcon } from "@/components/ui/icons";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { num } from "@/lib/format";

type FarmRow = { id: string; name: string; plan: string; status: string; created_at: string };

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
  const [{ data: fData }, { data: mData }, { data: uData }, { data: jData }, { data: ftData }] = await Promise.all([
    supabase.from("farms").select("id, name, plan, status, created_at").order("created_at", { ascending: false }),
    supabase.from("machines").select("farm_id").is("deleted_at", null),
    supabase.from("users").select("farm_id, active"),
    supabase.from("job_cards").select("farm_id, created_at").is("deleted_at", null),
    supabase.from("faults").select("farm_id, created_at").is("deleted_at", null),
  ]);
  const farms = (fData as FarmRow[] | null) ?? [];

  const count = (rows: { farm_id: string }[] | null, pred?: (r: { farm_id: string } & Record<string, unknown>) => boolean) => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) if (!pred || pred(r as { farm_id: string } & Record<string, unknown>)) m.set(r.farm_id, (m.get(r.farm_id) ?? 0) + 1);
    return m;
  };
  const machinesBy = count(mData as { farm_id: string }[] | null);
  const activeUsersBy = count(uData as { farm_id: string; active: boolean }[] | null, (r) => r.active === true);
  const jobsThisMonthBy = count(jData as { farm_id: string; created_at: string }[] | null, (r) => String(r.created_at) >= monthStart);

  const lastActivityBy = new Map<string, string>();
  for (const rows of [jData, ftData] as ({ farm_id: string; created_at: string }[] | null)[]) {
    for (const r of rows ?? []) {
      const cur = lastActivityBy.get(r.farm_id);
      if (!cur || r.created_at > cur) lastActivityBy.set(r.farm_id, r.created_at);
    }
  }
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

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Farms"
        meta={farms.length > 0 ? `${num(farms.length)} farm${farms.length === 1 ? "" : "s"}` : undefined}
        lead="Every farm on FleetWise. Open one to change its plan or status, or to help it in support mode."
        actions={newFarm}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.created ? t("admin.farmCreated", locale) : undefined} />

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
