import Link from "next/link";

import { APP_NAME } from "@/lib/env";
import { COMPANY, TERMS_VERSION, type Clause } from "@/lib/legal";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { PublicShell, SITE_GUTTER } from "@/components/public-shell";

/**
 * The shared shell for /terms and /privacy.
 *
 * Public, and deliberately outside every gate: somebody deciding whether to sign up has not
 * signed in, and somebody whose account has been closed must still be able to read what
 * they agreed to. There is no reason either document should ever require a session.
 *
 * The wording is English only, and the page says so. Every other string in this product is
 * a translation key, but a translated CONTRACT is a second document that can disagree with
 * the first, and "which version binds" is the question nobody wants to answer in front of a
 * magistrate. Pointing an Afrikaans reader at a person to talk to is more honest than a
 * machine translation of a liability clause. (The header and footer around it follow the
 * device language like every other page before sign-in; the clauses do not.)
 *
 * Laid out as the website's own privacy page: a green band with a gold eyebrow and the
 * title, then the text on the page ground.
 */
export async function LegalPage({
  title,
  intro,
  clauses,
  otherHref,
  otherLabel,
}: {
  title: string;
  intro: string;
  clauses: Clause[];
  otherHref: string;
  otherLabel: string;
}) {
  const locale = await deviceLocale();
  return (
    <PublicShell locale={locale} width="full">
      <section className="bg-brand-800 py-14 text-white lg:py-20">
        <div className={SITE_GUTTER}>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent">{t("publicNav.legalEyebrow", locale)}</p>
          <h1 className="mt-4 text-4xl font-bold leading-[1.04] tracking-[-0.04em] text-white lg:text-5xl">{title}</h1>
          <p className="mt-5 max-w-3xl text-lg leading-relaxed text-white/85">{intro}</p>
        </div>
      </section>
      <div className={`${SITE_GUTTER} py-12 lg:py-16`}>
      <div className="max-w-3xl">
      <p className="text-sm text-sand-600">
        Version {TERMS_VERSION}. {COMPANY.legalName}, registration {COMPANY.regNumber},{" "}
        {COMPANY.address}.
      </p>
      <p className="mt-1 text-sm text-sand-600">
        This page is written in English. If you would rather go through it in Afrikaans,
        email {COMPANY.email} and a person will take you through it.
      </p>

      <div className="mt-10 space-y-10">
        {clauses.map((c) => (
          <section key={c.heading}>
            <h2 className="text-2xl font-bold tracking-tight text-ink">{c.heading}</h2>
            {c.body.map((p, i) => (
              <p key={i} className="mt-3 text-base leading-relaxed text-sand-800">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>

      <div className="mt-10 flex flex-wrap gap-4 border-t border-sand-300 pt-6 text-sm">
        <Link href={otherHref} className="font-medium text-brand-ink underline">
          {otherLabel}
        </Link>
        <Link href="/signup" className="font-medium text-brand-ink underline">
          Start using {APP_NAME}
        </Link>
        <a href={`mailto:${COMPANY.email}`} className="font-medium text-brand-ink underline">
          {COMPANY.email}
        </a>
      </div>
      </div>
      </div>
    </PublicShell>
  );
}
