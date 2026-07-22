import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { updateFarm, impersonateFarm } from "./actions";
import { inviteUser, setUserActive } from "@/app/(app)/team/actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { ChevronLeftIcon } from "@/components/ui/icons";

type Farm = { id: string; name: string; tier: string; status: string; created_at: string };
type FarmUser = { id: string; name: string; role: string; email: string | null; active: boolean };
type Access = { id: number; user_id: string | null; action: string; at: string };

export default async function FarmDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; invited?: string; entered?: string }>;
}) {
  await requireRole(["rr_admin"]);
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: farmData } = await supabase.from("farms").select("id, name, tier, status, created_at").eq("id", id).maybeSingle();
  const farm = farmData as Farm | null;
  if (!farm) notFound();

  const [{ data: usersData }, { data: accessData }] = await Promise.all([
    supabase.from("users").select("id, name, role, email, active").eq("farm_id", id).order("role"),
    supabase.from("audit_log").select("id, user_id, action, at").eq("entity", "admin_farm_access").eq("farm_id", id).order("at", { ascending: false }).limit(10),
  ]);
  const users = (usersData as FarmUser[] | null) ?? [];
  const access = (accessData as Access[] | null) ?? [];
  const adminIds = [...new Set(access.map((a) => a.user_id).filter(Boolean) as string[])];
  const { data: adminUsers } = adminIds.length ? await supabase.from("users").select("id, name").in("id", adminIds) : { data: [] };
  const adminName = Object.fromEntries(((adminUsers as { id: string; name: string }[] | null) ?? []).map((u) => [u.id, u.name]));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/admin/farms" className="focus-ring inline-flex items-center gap-1 rounded-md text-sm text-sand-500">
          <ChevronLeftIcon className="text-[1rem]" /> Farms
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-sand-900">{farm.name}</h1>
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? "Saved." : sp.invited ? "Invited — they sign in via the magic link." : sp.entered ? "Support access logged." : undefined} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            action={
              <form action={impersonateFarm}>
                <input type="hidden" name="id" value={farm.id} />
                <SubmitButton variant="secondary" size="sm">Act into farm (logged)</SubmitButton>
              </form>
            }
          >
            <CardTitle>Subscription</CardTitle>
          </CardHeader>
          <form action={updateFarm} className="flex flex-col gap-3">
            <input type="hidden" name="id" value={farm.id} />
            <Field label="Tier" htmlFor="tier">
              <Select id="tier" name="tier" defaultValue={farm.tier}>
                <option value="starter">Starter</option>
                <option value="standard">Standard</option>
                <option value="large">Large</option>
              </Select>
            </Field>
            <Field label="Status" htmlFor="status">
              <Select id="status" name="status" defaultValue={farm.status}>
                <option value="trial">Trial</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </Field>
            <SubmitButton variant="primary" className="self-start">Save</SubmitButton>
          </form>
        </Card>

        <Card>
          <CardHeader><CardTitle>Support access log</CardTitle></CardHeader>
          {access.length === 0 ? (
            <p className="text-sm text-sand-500">No support access recorded.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-sand-100 text-sm">
              {access.map((a) => (
                <li key={a.id} className="flex justify-between py-1.5">
                  <span>{a.user_id ? adminName[a.user_id] ?? "admin" : "admin"} · {a.action}</span>
                  <span className="text-sand-400">{new Date(a.at).toLocaleString("en-ZA")}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Invite user</CardTitle></CardHeader>
        <form action={inviteUser} className="flex flex-col gap-3">
          <input type="hidden" name="farm_id" value={farm.id} />
          <input type="hidden" name="back" value={`/admin/farms/${farm.id}`} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="inv-name" required><Input id="inv-name" name="name" required /></Field>
            <Field label="Email" htmlFor="inv-email" required><Input id="inv-email" name="email" type="email" required /></Field>
            <Field label="Role" htmlFor="inv-role">
              <Select id="inv-role" name="role" defaultValue="owner">
                <option value="owner">Owner</option>
                <option value="manager">Manager</option>
                <option value="mechanic">Mechanic</option>
                <option value="operator">Operator</option>
              </Select>
            </Field>
            <Field label="Language" htmlFor="inv-lang">
              <Select id="inv-lang" name="language" defaultValue="af">
                <option value="af">Afrikaans</option>
                <option value="en">English</option>
              </Select>
            </Field>
          </div>
          <SubmitButton variant="primary" className="self-start">Invite</SubmitButton>
        </form>
      </Card>

      <Card flush>
        <CardHeader className="px-4 pt-4"><CardTitle>Users</CardTitle></CardHeader>
        {users.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-sand-500">No users yet — invite the owner above.</p>
        ) : (
          <Table>
            <Thead><Tr><Th>Name</Th><Th>Role</Th><Th>Email</Th><Th>Active</Th><Th /></Tr></Thead>
            <Tbody>
              {users.map((u) => (
                <Tr key={u.id}>
                  <Td className="font-medium text-sand-900">{u.name}</Td>
                  <Td><Badge tone="neutral" className="capitalize">{u.role}</Badge></Td>
                  <Td className="text-sand-500">{u.email ?? "—"}</Td>
                  <Td>{u.active ? <Badge tone="ok">yes</Badge> : <Badge tone="danger">no</Badge>}</Td>
                  <Td className="text-right">
                    <form action={setUserActive}>
                      <input type="hidden" name="id" value={u.id} />
                      <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                      <input type="hidden" name="back" value={`/admin/farms/${farm.id}`} />
                      <Button type="submit" variant="ghost" size="sm">{u.active ? "Deactivate" : "Activate"}</Button>
                    </form>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
