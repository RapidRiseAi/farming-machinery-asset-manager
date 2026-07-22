import Link from "next/link";
import { t } from "@/lib/i18n";
import { buttonVariants } from "@/components/ui/button";
import { MachinesIcon } from "@/components/ui/icons";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 p-6">
      <div className="flex flex-col gap-4">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-[1.8rem] text-white shadow-soft">
          <MachinesIcon />
        </span>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-sand-900">{t("app.name")}</h1>
          <p className="mt-2 text-lg text-sand-600">{t("app.tagline")}</p>
        </div>
      </div>
      <Link href="/login" className={buttonVariants({ variant: "primary", size: "lg" })}>
        {t("auth.getStarted")}
      </Link>
    </main>
  );
}
