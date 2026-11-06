import { requireProfile } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { shortDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { must } from "@/lib/supabase/must";
import { createServiceClient } from "@/lib/supabase/service";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { acceptOwnership, declineOwnership } from "./actions";

/** Where the person offered a business says yes or no. It is theirs alone to answer. */
export const dynamic = "force-dynamic";

type Offer = { id: string; farm_id: string; expires_at: string; farms: { name: string } | null; users: { name: string } | null };

export default async function HandoverPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.lang;

  const svc = createServiceClient();
  const data = must(
    await svc
      .from("farm_ownership_transfers")
      .select("id, farm_id, expires_at, farms(name), users:users!farm_ownership_transfers_from_user_fkey(name)")
      .eq("to_user", profile.id)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString()),
    "handover:offers",
  );
  const offers = (data ?? []) as unknown as Offer[];

  return (
    <PageContainer>
      <PageHeader title={t("handover.title", locale)} />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      {offers.length === 0 ? <EmptyState title={t("handover.none", locale)} /> : null}
      {offers.map((offer) => (
        <Card key={offer.id}>
          <CardHeader>
            <CardTitle as="h3">
              {t("handover.offerTitle", locale)
                .replace("{from}", () => offer.users?.name ?? "")
                .replace("{business}", () => offer.farms?.name ?? "")}
            </CardTitle>
          </CardHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-sand-700">
            <li>{t("handover.means1", locale)}</li>
            <li>{t("handover.means2", locale)}</li>
            <li>{t("handover.means3", locale)}</li>
          </ul>
          <p className="mt-3 text-sm text-sand-500">
            {t("handover.ends", locale).replace("{date}", () => shortDate(offer.expires_at, locale))}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <form action={acceptOwnership}>
              <input type="hidden" name="id" value={offer.id} />
              <SubmitButton variant="primary">{t("handover.accept", locale)}</SubmitButton>
            </form>
            <form action={declineOwnership}>
              <input type="hidden" name="id" value={offer.id} />
              <SubmitButton variant="secondary">{t("handover.decline", locale)}</SubmitButton>
            </form>
          </div>
        </Card>
      ))}
    </PageContainer>
  );
}
