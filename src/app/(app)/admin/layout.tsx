import Link from "next/link";
import { requireRole } from "@/lib/auth";

// The RR admin console is internal (Rapid Rise staff) — English-only, unlike the
// bilingual farmer-facing UI.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRole(["rr_admin"]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-sand-400">Rapid Rise admin</p>
        <nav className="flex items-center gap-1 text-sm">
          <Link href="/admin/farms" className="focus-ring rounded-md px-3 py-1.5 font-medium text-sand-700 hover:bg-sand-100">Farms</Link>
          <Link href="/admin/templates" className="focus-ring rounded-md px-3 py-1.5 font-medium text-sand-700 hover:bg-sand-100">Templates</Link>
        </nav>
      </div>
      {children}
    </div>
  );
}
