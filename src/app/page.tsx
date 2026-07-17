import Link from "next/link";
import { t } from "@/lib/i18n";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">{t("app.name")}</h1>
        <p className="mt-1 text-gray-600">{t("app.tagline")}</p>
      </div>
      <div className="flex flex-col gap-3">
        <Link
          href="/login"
          className="rounded-lg bg-status-ok px-4 py-3 text-center font-medium text-white"
        >
          {t("auth.signIn")}
        </Link>
      </div>
      <p className="text-xs text-gray-400">Week 1 foundation.</p>
    </main>
  );
}
