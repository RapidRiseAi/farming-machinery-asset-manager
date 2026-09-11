import Link from "next/link";

import { APP_NAME } from "@/lib/env";
import { COMPANY, TERMS_VERSION, type Clause } from "@/lib/legal";
import { MachinesIcon } from "@/components/ui/icons";

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
 * machine translation of a liability clause.
 */
export function LegalPage({
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
  return (
    <main className="mx-auto w-full max-w-2xl p-6 pb-16">
      <Link href="/" className="flex items-center gap-3">
        <MachinesIcon className="size-8 text-brand-ink" aria-hidden="true" />
        <span className="text-xl font-semibold text-brand-ink">{APP_NAME}</span>
      </Link>

      <h1 className="mt-8 text-3xl font-semibold">{title}</h1>
      <p className="mt-2 text-sand-700">{intro}</p>
      <p className="mt-1 text-sm text-sand-600">
        Version {TERMS_VERSION}. {COMPANY.legalName}, registration {COMPANY.regNumber},{" "}
        {COMPANY.address}.
      </p>
      <p className="mt-1 text-sm text-sand-600">
        This page is written in English. If you would rather go through it in Afrikaans,
        email {COMPANY.email} and a person will take you through it.
      </p>

      <div className="mt-8 space-y-8">
        {clauses.map((c) => (
          <section key={c.heading}>
            <h2 className="text-lg font-semibold">{c.heading}</h2>
            {c.body.map((p, i) => (
              <p key={i} className="mt-2 text-sand-800">
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
    </main>
  );
}
