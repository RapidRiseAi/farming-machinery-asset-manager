import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { signOut } from "./actions";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireProfile();
  const locale = profile.language;

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
        <Link href="/dashboard" className="font-bold">
          {t("app.name", locale)}
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/machines" className="text-gray-700">
            {t("nav.machines", locale)}
          </Link>
          <Link href="/jobcards" className="text-gray-700">
            {t("nav.jobcards", locale)}
          </Link>
          <Link href="/faults" className="text-gray-700">
            {t("nav.faults", locale)}
          </Link>
          {profile.role === "rr_admin" ? (
            <Link href="/admin/farms" className="text-gray-700">
              {t("nav.admin", locale)}
            </Link>
          ) : null}
          <form action={signOut}>
            <button className="text-gray-500">{t("nav.signOut", locale)}</button>
          </form>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl p-4">{children}</main>
    </div>
  );
}
