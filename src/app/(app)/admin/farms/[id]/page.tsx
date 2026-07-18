import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { updateFarm } from "./actions";
import { inviteUser, setUserActive } from "@/app/(app)/team/actions";

type Farm = { id: string; name: string; tier: string; status: string; created_at: string };
type FarmUser = { id: string; name: string; role: string; email: string | null; active: boolean };

export default async function FarmDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; invited?: string }>;
}) {
  await requireRole(["rr_admin"]);
  const { id } = await params;
  const sp = await searchParams;

  const supabase = await createClient();
  const { data: farmData } = await supabase
    .from("farms")
    .select("id, name, tier, status, created_at")
    .eq("id", id)
    .maybeSingle();
  const farm = farmData as Farm | null;
  if (!farm) notFound();

  const { data: usersData } = await supabase
    .from("users")
    .select("id, name, role, email, active")
    .eq("farm_id", id)
    .order("role");
  const users = (usersData as FarmUser[] | null) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/farms" className="text-sm text-gray-500">
          ← Farms
        </Link>
        <h1 className="mt-1 text-xl font-bold">{farm.name}</h1>
      </div>

      {sp.error ? (
        <p className="rounded bg-red-50 p-2 text-sm text-red-700">{sp.error}</p>
      ) : null}
      {sp.saved ? (
        <p className="rounded bg-green-50 p-2 text-sm text-green-700">Saved.</p>
      ) : null}
      {sp.invited ? (
        <p className="rounded bg-green-50 p-2 text-sm text-green-700">Invited — they sign in via the magic-link.</p>
      ) : null}

      <form action={updateFarm} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-4">
        <input type="hidden" name="id" value={farm.id} />
        <h2 className="font-medium">Subscription</h2>
        <label className="text-sm text-gray-500">Tier</label>
        <select name="tier" defaultValue={farm.tier} className="rounded border border-gray-300 p-2">
          <option value="starter">Starter</option>
          <option value="standard">Standard</option>
          <option value="large">Large</option>
        </select>
        <label className="text-sm text-gray-500">Status</label>
        <select name="status" defaultValue={farm.status} className="rounded border border-gray-300 p-2">
          <option value="trial">Trial</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button className="rounded-lg bg-status-ok px-4 py-2 font-medium text-white">Save</button>
      </form>

      <div className="flex flex-col gap-3">
        <form action={inviteUser} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3">
          <h2 className="font-medium">Invite user</h2>
          <input type="hidden" name="farm_id" value={farm.id} />
          <input type="hidden" name="back" value={`/admin/farms/${farm.id}`} />
          <input name="name" required placeholder="Name" className="rounded border border-gray-300 p-2" />
          <input name="email" type="email" required placeholder="Email" className="rounded border border-gray-300 p-2" />
          <select name="role" defaultValue="owner" className="rounded border border-gray-300 p-2">
            <option value="owner">Owner</option>
            <option value="manager">Manager</option>
            <option value="mechanic">Mechanic</option>
            <option value="operator">Operator</option>
          </select>
          <button className="self-start rounded-lg bg-status-ok px-4 py-2 text-sm font-medium text-white">Invite</button>
        </form>

        <h2 className="font-medium">Users</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-gray-500">
              <tr>
                <th className="py-2">Name</th>
                <th>Role</th>
                <th>Email</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-gray-100">
                  <td className="py-2">{u.name}</td>
                  <td>{u.role}</td>
                  <td className="text-gray-500">{u.email ?? "—"}</td>
                  <td>{u.active ? "yes" : "no"}</td>
                  <td className="text-right">
                    <form action={setUserActive}>
                      <input type="hidden" name="id" value={u.id} />
                      <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                      <input type="hidden" name="back" value={`/admin/farms/${farm.id}`} />
                      <button className="rounded border border-gray-300 px-2 py-1 text-xs">
                        {u.active ? "Deactivate" : "Activate"}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-gray-400">No users yet — invite the owner above.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
