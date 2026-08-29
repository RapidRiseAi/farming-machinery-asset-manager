import { t, type Lang } from "@/lib/i18n";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The three per-vehicle document packs (FR-13.4), as one card on machine detail.
 *
 * A server component with no client JS — three anchors to server routes that stream a
 * PDF. It is a CARD rather than an item in the header's "view all" disclosure because
 * F15 recorded what a disclosure does to something nobody has been told exists: the
 * sidebar's "Everything else" hid seven destinations from anyone who never opened it.
 * A farmer facing a GLOBALG.A.P. audit next week has to be able to find this without
 * having gone looking for it.
 *
 * The hint line is load-bearing, not decoration. It is the promise the packs make — that
 * a missing licence is printed as a missing licence — and a farmer who does not know
 * that will not trust a pack that names their own gaps.
 *
 * 48px rows on a phone, stepping down only at `sm` where there is a mouse (the button
 * kit's own rule); every control carries its word.
 */
export function DocumentPacks({
  machineId,
  locale,
  role,
}: {
  machineId: string;
  locale: Lang;
  /**
   * The viewer's role. Optional so the component is safe to render without it, but pass
   * it: `authorizeMachinePack` refuses `operator` and `workshop` with a 403 before any
   * query runs, so for those two the card is a button that always fails.
   *
   * That refusal lives in the route rather than in RLS on purpose, and G32(f) is the
   * proof of why: a linked contractor may legitimately read `purchase_price_cents` and
   * `supplier` on a machine it is working on, so a sale pack would print what the farm
   * paid and who from. Hiding the card here is presentation only — the route is what
   * actually refuses, and it still would if this prop were forgotten.
   */
  role?: string | null;
}) {
  if (role === "operator" || role === "workshop") return null;

  const packs = [
    { href: `/api/packs/machine/${machineId}/compliance`, label: t("machine.compliancePack", locale), hint: t("machine.compliancePackHint", locale) },
    { href: `/api/packs/machine/${machineId}/sale`, label: t("machine.salePack", locale), hint: t("machine.salePackHint", locale) },
    { href: `/api/packs/machine/${machineId}/warranty`, label: t("machine.warrantyPack", locale), hint: t("machine.warrantyPackHint", locale) },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("machine.packsTitle", locale)}</CardTitle>
      </CardHeader>
      <p className="text-sm text-sand-600">{t("machine.packsHint", locale)}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {packs.map((p) => (
          <li key={p.href} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sand-200 p-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-sand-900">{p.label}</p>
              <p className="text-xs leading-snug text-sand-500">{p.hint}</p>
            </div>
            <a href={p.href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {t("machine.packDownload", locale)}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
