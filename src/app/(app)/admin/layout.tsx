import { requireRole } from "@/lib/auth";

// The RR admin console is internal (Rapid Rise staff) — English-only, unlike the
// bilingual farmer-facing UI.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRole(["rr_admin"]);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
        Rapid Rise admin
      </p>
      {children}
    </div>
  );
}
