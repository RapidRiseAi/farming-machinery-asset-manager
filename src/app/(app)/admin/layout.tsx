import { requireRole } from "@/lib/auth";

// The RR admin console is internal (Rapid Rise staff). Its sections (Farms, Partner
// catalogue, Templates, Subscriptions) are a "Rapid Rise" group at the top of the app's
// own sidebar and phone menu, built in (app)/layout.tsx. They used to be a second,
// English-only text subnav here, split from the "Admin" row filed under Account.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRole(["rr_admin"]);
  return <>{children}</>;
}
