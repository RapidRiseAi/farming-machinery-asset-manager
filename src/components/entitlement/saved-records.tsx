import type { ReactNode } from "react";

import { t, type Lang } from "@/lib/i18n";
import { downloadLabels } from "@/lib/interaction-labels";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DownloadLink } from "@/components/ui/download-link";

/**
 * What a business saved with a feature its plan no longer includes (decision 37): readable
 * here and in the business export, with nothing new added and no fresh analysis worked out.
 * The page reads the saved rows with the person's own session, so roles and sites still
 * decide what appears; this only frames them.
 */
export function SavedRecords({
  locale,
  feature,
  farmId,
  canExport,
  shown,
  children,
}: {
  locale: Lang;
  /** Stem under `upgrade.feature.*`. */
  feature: string;
  farmId: string | null;
  /** Owners and managers take the business export; others read what their role allows. */
  canExport: boolean;
  /** How many rows are listed: the newest only, the export holds the rest. */
  shown: number;
  children: ReactNode;
}) {
  const name = t(`upgrade.feature.${feature}`, locale);
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3">{t("savedRecords.title", locale)}</CardTitle>
      </CardHeader>
      <p className="mb-3 text-sm text-sand-600">
        {t("savedRecords.hint", locale).replace("{feature}", name)}{" "}
        {t("savedRecords.newest", locale).replace("{n}", String(shown))}
      </p>
      {children}
      {canExport && farmId ? (
        <div className="mt-3">
          <DownloadLink
            href={`/api/farm/export?farm=${farmId}`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
            labels={downloadLabels(locale)}
          >
            {t("savedRecords.export", locale)}
          </DownloadLink>
        </div>
      ) : null}
    </Card>
  );
}
