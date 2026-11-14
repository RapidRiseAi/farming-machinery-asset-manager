import Link from "next/link";

import { cn } from "@/components/ui/cn";
import { t, type Lang } from "@/lib/i18n";
import type { AssetView } from "./asset-views";

/**
 * "Which kind is this?", asked before anything else on the add page, with what each can
 * really do (decision register of 12 November 2026, decisions 3 and 33). Two links rather
 * than radios, so the form below reloads with the right type list and works without
 * JavaScript. The words are capabilities, never importance: a large pump is still
 * support equipment, a parked bakkie is still a fleet asset.
 */
export function AssetKindChooser({
  current,
  hrefFor,
  locale,
}: {
  current: AssetView;
  hrefFor: (kind: AssetView) => string;
  locale: Lang;
}) {
  const kinds: { key: AssetView; title: string; who: string; has: string[]; not?: string }[] = [
    {
      key: "fleet",
      title: t("assets.kindFleetTitle", locale),
      who: t("assets.kindFleetWho", locale),
      has: [t("assets.kindFleetHas1", locale), t("assets.kindFleetHas2", locale), t("assets.kindFleetHas3", locale)],
    },
    {
      key: "equipment",
      title: t("assets.kindEquipmentTitle", locale),
      who: t("assets.kindEquipmentWho", locale),
      has: [t("assets.kindEquipmentHas1", locale), t("assets.kindEquipmentHas2", locale), t("assets.kindEquipmentHas3", locale)],
      not: t("assets.kindEquipmentNot", locale),
    },
  ];
  return (
    <section aria-labelledby="asset-kind-heading" className="flex flex-col gap-3">
      <h2 id="asset-kind-heading" className="text-base font-semibold text-sand-900">
        {t("assets.kindQuestion", locale)}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {kinds.map((k) => {
          const on = k.key === current;
          return (
            <Link
              key={k.key}
              href={hrefFor(k.key)}
              aria-current={on ? "page" : undefined}
              className={cn(
                "focus-ring flex flex-col gap-2 rounded-xl border p-4 text-sm transition-colors",
                on ? "border-brand-600 bg-brand-tint ring-1 ring-brand-600" : "border-sand-200 bg-surface hover:border-sand-300",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-semibold text-sand-900">{k.title}</span>
                {on ? <span className="text-xs font-semibold text-brand-ink">{t("assets.kindChosen", locale)}</span> : null}
              </span>
              <span className="text-sand-600">{k.who}</span>
              <ul className="list-disc pl-5 text-sand-700">
                {k.has.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {k.not ? <span className="text-sand-600">{k.not}</span> : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
