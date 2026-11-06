import { requireRole } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { mustAll } from "@/lib/supabase/must";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Flash } from "@/components/ui/flash";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { grantFeature, revokeFeature, setFeatureReleased } from "./actions";

/**
 * Features in testing. Internal, English-only like the rest of the RR console. Turn one on for
 * a business to try it, and release it to everyone once it has been tested.
 */
export const dynamic = "force-dynamic";

type Flag = { key: string; released: boolean; note: string | null };
type Access = { key: string; farm_id: string };
type Business = { id: string; name: string };

export default async function AdminFeaturesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireRole(["rr_admin"]);
  const sp = await searchParams;
  const supabase = await createClient();
  const results = await Promise.all([
    supabase.from("feature_flags").select("key, released, note").order("key"),
    supabase.from("farm_feature_access").select("key, farm_id"),
    supabase.from("farms").select("id, name").is("deleted_at", null).order("name").limit(1000),
  ]);
  mustAll(results, "admin-features:page");
  const [{ data: flagData }, { data: accessData }, { data: farmData }] = results;
  const flags = (flagData ?? []) as Flag[];
  const access = (accessData ?? []) as Access[];
  const farms = (farmData ?? []) as Business[];
  const nameOf = new Map(farms.map((f) => [f.id, f.name]));

  return (
    <PageContainer size="wide">
      <PageHeader title="Features in testing" lead="Try a feature on chosen businesses, then release it to everyone." />
      <Flash tone="error" message={errorMessage(sp.error, profile.lang)} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", profile.lang) : undefined} />

      {flags.map((flag) => {
        const testers = access.filter((a) => a.key === flag.key);
        const others = farms.filter((f) => !testers.some((a) => a.farm_id === f.id));
        return (
          <Card key={flag.key}>
            <CardHeader
              action={<Badge tone={flag.released ? "ok" : "warning"}>{flag.released ? "Released to everyone" : "In testing"}</Badge>}
            >
              <CardTitle as="h3">{flag.key}</CardTitle>
            </CardHeader>
            {flag.note ? <p className="text-sm text-sand-600">{flag.note}</p> : null}

            <h4 className="mt-4 text-sm font-semibold text-sand-900">Testing on</h4>
            {testers.length === 0 ? <p className="text-sm text-sand-500">No business yet.</p> : null}
            <ul className="mt-1 flex flex-col divide-y divide-sand-100">
              {testers.map((a) => (
                <li key={a.farm_id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-sm text-sand-800">{nameOf.get(a.farm_id) ?? a.farm_id}</span>
                  <form action={revokeFeature}>
                    <input type="hidden" name="key" value={flag.key} />
                    <input type="hidden" name="farm_id" value={a.farm_id} />
                    <SubmitButton variant="ghost" size="sm">Turn off</SubmitButton>
                  </form>
                </li>
              ))}
            </ul>

            {others.length > 0 ? (
              <form action={grantFeature} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="key" value={flag.key} />
                <div className="min-w-0 flex-1 basis-56">
                  <Select name="farm_id" aria-label="Business to test on" defaultValue={others[0].id}>
                    {others.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </Select>
                </div>
                <SubmitButton variant="secondary">Turn on for this business</SubmitButton>
              </form>
            ) : null}

            <form action={setFeatureReleased} className="mt-4 border-t border-sand-100 pt-3">
              <input type="hidden" name="key" value={flag.key} />
              <input type="hidden" name="released" value={flag.released ? "false" : "true"} />
              <SubmitButton variant={flag.released ? "secondary" : "primary"}>
                {flag.released ? "Take back to testing" : "Release to everyone"}
              </SubmitButton>
            </form>
          </Card>
        );
      })}
    </PageContainer>
  );
}
