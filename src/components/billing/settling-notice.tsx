import Link from "next/link";

import { t, type Lang } from "@/lib/i18n";
import { buttonVariants } from "@/components/ui/button";

/**
 * What a stopped-farm page shows IN PLACE of its Pay button while money is already moving
 * on the invoice that button would charge (`settlingOnInvoice`).
 *
 * No Pay button at all in this state. It is the one control that must not be offered to
 * somebody whose money is already moving: the database would refuse it, but being refused
 * is not the experience to give a customer thirty seconds after they paid. `/activate` had
 * this and `/suspended` did not, so a paused farm that had just paid was shown Pay now and
 * then "already in progress" (review finding app-10); both pages render this now.
 *
 * One state only, a checkout open at the bank. The "payment received" variant and its
 * `/suspended` wording are gone (review round 5, finding app-1): a page never sees a
 * success on the invoice it offers, except on one owed again, where it hid the Pay button
 * for good.
 */
export function SettlingNotice({ refreshHref, locale }: { refreshHref: string; locale: Lang }) {
  return (
    <div className="mt-6">
      <div className="rounded-xl border border-callout-info-edge bg-callout-info-bg px-4 py-3.5">
        <p className="text-base font-semibold text-sand-900">{t("activate.settlingInflightTitle", locale)}</p>
        <p className="mt-1 text-sm leading-relaxed text-sand-800">{t("activate.settlingInflightBody", locale)}</p>
      </div>
      {/* A plain link to this same page. It is a GET, so a reload cannot repeat anything,
          and it gives somebody watching a spinner something to press other than the
          browser's back button. */}
      <Link href={refreshHref} className={`${buttonVariants({ variant: "secondary" })} mt-3 w-full`}>
        {t("activate.settlingRefresh", locale)}
      </Link>
    </div>
  );
}
