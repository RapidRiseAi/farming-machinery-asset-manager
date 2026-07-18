import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { MachineFields } from "@/components/machine-fields";
import { createMachine } from "../actions";

export default async function NewMachinePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole(["owner", "manager"]);
  const sp = await searchParams;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/machines" className="text-sm text-gray-500">
        ← Machines
      </Link>
      <h1 className="text-xl font-bold">Add machine</h1>
      {sp.error ? (
        <p className="rounded bg-red-50 p-2 text-sm text-red-700">{sp.error}</p>
      ) : null}
      <form action={createMachine} className="flex flex-col gap-3">
        <MachineFields />
        <button className="rounded-lg bg-status-ok px-4 py-3 font-medium text-white">Save</button>
      </form>
      <p className="text-xs text-gray-400">
        Photos &amp; documents attach once the machine exists (needs Storage).
      </p>
    </div>
  );
}
