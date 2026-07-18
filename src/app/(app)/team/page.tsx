import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { inviteUser, setUserActive } from "./actions";

type TeamUser = { id: string; name: string; role: string; email: string | null; active: boolean };

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invited?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role === "rr_admin") redirect("/admin/farms");
  const sp = await searchParams;

  const supabase = await createClient();
  const { data } = await supabase.from("users").select("id, name, role, email, active").order("role");
  const users = (data as TeamUser[] | null) ?? [];

  const canManage = profile.role === "owner" || profile.role === "manager";
  const input = "rounded border border-gray-300 p-2 text-sm";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Team</h1>
      {sp.error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{sp.error}</p> : null}
      {sp.invited ? <p className="rounded bg-green-50 p-2 text-sm text-green-700">Invited — they sign in via the magic-link on the login page.</p> : null}
      {sp.saved ? <p className="rounded bg-green-50 p-2 text-sm text-green-700">Saved.</p> : null}

      {canManage && profile.farm_id ? (
        <form action={inviteUser} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3">
          <h2 className="font-medium">Invite a worker</h2>
          <input type="hidden" name="farm_id" value={profile.farm_id} />
          <input type="hidden" name="back" value="/team" />
          <input name="name" required placeholder="Name" className={input} />
          <input name="email" type="email" required placeholder="Email" className={input} />
          <div className="flex gap-2">
            <select name="role" defaultValue="operator" className={`${input} flex-1`}>
              <option value="manager">Manager</option>
              <option value="mechanic">Mechanic</option>
              <option value="operator">Operator</option>
            </select>
            <select name="language" defaultValue="af" className={`${input} w-28`}>
              <option value="af">Afrikaans</option>
              <option value="en">English</option>
            </select>
          </div>
          <button className="self-start rounded-lg bg-status-ok px-4 py-2 text-sm font-medium text-white">Invite</button>
        </form>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-gray-500">
            <tr><th className="py-2">Name</th><th>Role</th><th>Email</th><th>Active</th>{canManage ? <th /> : null}</tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-gray-100">
                <td className="py-2">{u.name}</td>
                <td>{u.role}</td>
                <td className="text-gray-500">{u.email ?? "—"}</td>
                <td>{u.active ? "yes" : "no"}</td>
                {canManage ? (
                  <td className="text-right">
                    {u.id !== profile.id ? (
                      <form action={setUserActive}>
                        <input type="hidden" name="id" value={u.id} />
                        <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                        <input type="hidden" name="back" value="/team" />
                        <button className="rounded border border-gray-300 px-2 py-1 text-xs">
                          {u.active ? "Deactivate" : "Activate"}
                        </button>
                      </form>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
