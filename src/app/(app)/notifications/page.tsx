import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { markRead, markAllRead } from "./actions";

type Note = { id: string; template: string; payload: Record<string, unknown>; status: string; created_at: string };

export default async function NotificationsPage() {
  const profile = await requireProfile();
  const supabase = await createClient();
  const { data } = await supabase
    .from("notifications")
    .select("id, template, payload, status, created_at")
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(50);
  const notes = (data as Note[] | null) ?? [];

  const mIds = [...new Set(notes.map((n) => n.payload?.machine_id).filter(Boolean) as string[])];
  const { data: ms } = mIds.length ? await supabase.from("machines").select("id, name").in("id", mIds) : { data: [] };
  const nameById = Object.fromEntries(((ms as { id: string; name: string }[] | null) ?? []).map((m) => [m.id, m.name]));

  const message = (n: Note): string => {
    const p = n.payload ?? {};
    const m = nameById[p.machine_id as string] ?? "";
    if (n.template === "fault_reported") return `${m}: ${p.description ?? "fault"} (${p.urgency ?? ""})`;
    if (n.template === "job_completed") return `${m}: job completed — ${rands(p.total_cents as number)}`;
    return n.template;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Notifications</h1>
        {notes.some((n) => n.status === "queued") ? (
          <form action={markAllRead}>
            <button className="text-sm text-status-ok">Mark all read</button>
          </form>
        ) : null}
      </div>
      <ul className="flex flex-col divide-y divide-gray-100">
        {notes.map((n) => (
          <li key={n.id} className={`flex items-center justify-between gap-2 py-2 ${n.status === "queued" ? "font-medium" : "text-gray-500"}`}>
            <span className="text-sm">{message(n)}</span>
            <span className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{new Date(n.created_at).toLocaleDateString("en-ZA")}</span>
              {n.status === "queued" ? (
                <form action={markRead}>
                  <input type="hidden" name="id" value={n.id} />
                  <button className="rounded border border-gray-300 px-2 py-0.5 text-xs">Read</button>
                </form>
              ) : null}
            </span>
          </li>
        ))}
        {notes.length === 0 ? <li className="py-6 text-gray-400">Nothing yet.</li> : null}
      </ul>
    </div>
  );
}
