import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-header";
import { t } from "@/lib/i18n";

/**
 * Shaped like the page it stands in for: a header with no action button, then cards
 * that each state a few facts under a title with a small Edit button. The generic
 * "form" skeleton drew input boxes and a Save button this screen no longer has, so the
 * real page used to land in a different shape from its placeholder.
 */
export default function PartnerSettingsLoading() {
  return (
    <PageContainer size="narrow">
      <div className="flex flex-col gap-4" aria-busy="true" role="status" aria-live="polite">
        {/* No profile is loaded yet, so this cannot know the language; the default one. */}
        <span className="sr-only">{t("common.loading")}</span>
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-8 w-52 max-w-full" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
        {[5, 5, 5].map((rows, card) => (
          <Card key={card}>
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-12 w-20 rounded-lg sm:h-10" />
            </div>
            <div className="mt-3 flex flex-col divide-y divide-sand-100">
              {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-4 w-40 max-w-full" />
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </PageContainer>
  );
}
