import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createFarm } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";

type FarmRow = { id: string; name: string; tier: string; status: string; created_at: string };

const statusTone = (s: string): BadgeTone =>
  s === "active" ? "ok" : s === "trial" ? "info" : s === "suspended" ? "warning" : "danger";

export default async function AdminFarmsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string }>;
}) {
  await requireRole(["rr_admin"]);
  const sp = await searchParams;
  const supabase = await createClient();

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const [{ data: fData }, { data: mData }, { data: uData }, { data: jData }, { data: ftData }] = await Promise.all([
    supabase.from("farms").select("id, name, tier, status, created_at").order("created_at", { ascending: false }),
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

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight text-sand-900">Farms</h1>
      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.created ? "Farm created." : undefined} />

      <Card>
        <CardHeader><CardTitle>Create farm</CardTitle></CardHeader>
        <form action={createFarm} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Farm name" htmlFor="farm-name" className="flex-1">
            <Input id="farm-name" name="name" required />
          </Field>
          <Field label="Tier" htmlFor="farm-tier">
            <Select id="farm-tier" name="tier" defaultValue="starter">
              <option value="starter">Starter (≤10)</option>
              <option value="standard">Standard (≤25)</option>
              <option value="large">Large (unlimited)</option>
            </Select>
          </Field>
          <SubmitButton variant="primary">Create farm</SubmitButton>
        </form>
      </Card>

      <Card flush>
        {farms.length === 0 ? (
          <p className="p-4 text-sm text-sand-500">No farms yet — create the first one above.</p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Farm</Th><Th>Tier</Th><Th>Status</Th>
                <Th className="text-right">Machines</Th>
                <Th className="text-right">Active users</Th>
                <Th className="text-right">Jobs (mo)</Th>
                <Th className="text-right">Last activity</Th>
              </Tr>
            </Thead>
            <Tbody>
              {farms.map((f) => {
                const d = daysAgo(lastActivityBy.get(f.id));
                const stale = d != null && d >= 14;
                return (
                  <Tr key={f.id}>
                    <Td className="font-medium">
                      <Link href={`/admin/farms/${f.id}`} className="focus-ring rounded text-brand-700 hover:underline">{f.name}</Link>
                    </Td>
                    <Td className="capitalize text-sand-600">{f.tier}</Td>
                    <Td><Badge tone={statusTone(f.status)} className="capitalize">{f.status}</Badge></Td>
                    <Td className="text-right tabular-nums">{machinesBy.get(f.id) ?? 0}</Td>
                    <Td className="text-right tabular-nums">{activeUsersBy.get(f.id) ?? 0}</Td>
                    <Td className="text-right tabular-nums">{jobsThisMonthBy.get(f.id) ?? 0}</Td>
                    <Td className={`text-right tabular-nums ${stale ? "text-status-overdue" : "text-sand-600"}`}>
                      {d == null ? "—" : d === 0 ? "today" : `${d}d ago`}
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
