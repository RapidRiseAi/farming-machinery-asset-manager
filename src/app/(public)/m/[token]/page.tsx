import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/service";
import { submitReading, submitFault } from "./actions";

// Ultra-light public page (Scope §4.2): no auth, minimal payload. Always dynamic.
export const dynamic = "force-dynamic";

async function getMachine(token: string) {
  try {
    const svc = createServiceClient();
    const { data } = await svc
      .from("machines")
      .select("id, name, meter_type")
      .eq("public_token", token)
      .is("deleted_at", null)
      .maybeSingle();
    return data as { id: string; name: string; meter_type: string } | null;
  } catch {
    // Service role not configured yet, or lookup failed.
    return null;
  }
}

export default async function PublicMachinePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const machine = await getMachine(token);

  if (!machine) {
    return (
      <main className="mx-auto max-w-sm p-6">
        <h1 className="text-lg font-bold">Machine not found</h1>
        <p className="mt-1 text-gray-500">This code isn’t recognised.</p>
      </main>
    );
  }

  const input = "rounded border border-gray-300 p-3";
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col gap-4 p-5">
      <h1 className="text-xl font-bold">{machine.name}</h1>
      {sp.sent ? (
        <p className="rounded bg-green-50 p-2 text-sm text-green-700">Thanks — sent!</p>
      ) : null}
      {sp.error ? (
        <p className="rounded bg-red-50 p-2 text-sm text-red-700">Something went wrong — try again.</p>
      ) : null}

      <form action={submitFault} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-4">
        <input type="hidden" name="token" value={token} />
        <span className="font-medium">Report a problem</span>
        <textarea name="description" required rows={3} placeholder="What’s wrong?" className={input} />
        <select name="urgency" defaultValue="can_work" className={input}>
          <option value="can_work">Can still work</option>
          <option value="limping">Limping</option>
          <option value="stopped">Stopped</option>
        </select>
        <input name="name" placeholder="Your name (optional)" className={input} />
        <button className="rounded-lg bg-status-overdue px-4 py-3 font-medium text-white">Send problem</button>
      </form>

      {machine.meter_type !== "none" ? (
        <form action={submitReading} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-4">
          <input type="hidden" name="token" value={token} />
          <span className="font-medium">Log reading ({machine.meter_type})</span>
          <input name="reading" type="number" inputMode="decimal" step="0.1" required placeholder="Current reading" className={input} />
          <input name="name" placeholder="Your name (optional)" className={input} />
          <button className="rounded-lg bg-status-ok px-4 py-3 font-medium text-white">Send reading</button>
        </form>
      ) : null}

      <Link href="/login" className="text-center text-sm text-gray-500">
        Log in for full history
      </Link>
    </main>
  );
}
