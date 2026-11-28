import { requireRole } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { shortDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { parseAppVersion, PLAY_STORE_URL, versionCodeOf } from "@/lib/native/app-version";
import { createServiceClient } from "@/lib/supabase/service";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Fact, FactList } from "@/components/ui/facts";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import builtVersion from "../../../../../native/version.json";
import { setAppVersions } from "./actions";

/**
 * Which FLEETWISE Android app phones are asked, or made, to update to (20261128100000, rules in
 * lib/native/app-version.ts, the steps in docs/ANDROID.md). Internal and English, like the rest
 * of the console.
 */
export const dynamic = "force-dynamic";

type Release = { latest: string; minimum: string; url: string; updated_at: string };

export default async function AppVersionPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const { data } = await createServiceClient().rpc("native_app_release", { p_platform: "android" });
  const release = data as Release | null;
  const built = parseAppVersion(builtVersion.version);

  return (
    <PageContainer>
      <PageHeader
        title="Android app versions"
        lead="Screens come from the site, so a web release reaches every phone by itself. Only a new build of the app itself needs this page."
      />
      {sp.error ? <Flash tone="error" message={errorMessage(sp.error, locale)} /> : null}
      {sp.saved ? <Flash tone="success" message={t("ui.saved", locale)} /> : null}

      <Card>
        <CardHeader><CardTitle as="h3">Now</CardTitle></CardHeader>
        {release ? (
          <FactList>
            <Fact label="Newest app (older apps are asked to update)" value={release.latest} />
            <Fact label="Oldest allowed (older apps must update)" value={release.minimum} />
            <Fact label="Update link" value={<span className="break-all">{release.url}</span>} />
            <Fact label="Last changed" value={shortDate(release.updated_at, "en")} />
          </FactList>
        ) : (
          <p className="text-sm text-sand-600">The setting could not be read. Phones are not asked anything while it cannot.</p>
        )}
        <p className="mt-3 text-sm text-sand-600">
          The app in the code is version <strong>{builtVersion.version}</strong>
          {built ? <> (build {versionCodeOf(built)})</> : null}. Every app built before 28 November 2026 is 1.0.0.
        </p>
      </Card>

      <Card>
        <CardHeader><CardTitle as="h3">Change</CardTitle></CardHeader>
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-sand-600">
          <li>Publish the new app first: on Google Play (and wait until the release is out to everyone), or upload the test build where the link below points.</li>
          <li>Then set the newest version to it. Every phone with an older app is asked to update each time it opens the app, and may tap &quot;Not now&quot;.</li>
          <li>Raise the oldest allowed only when the site needs the new app to work. Phones below it cannot use FLEETWISE until they update.</li>
        </ol>
        <form action={setAppVersions} className="flex flex-col gap-4">
          <Field label="Newest version" htmlFor="app-latest" hint="Three numbers, like 1.1.0." required>
            <Input id="app-latest" name="latest" required defaultValue={release?.latest ?? "1.0.0"} inputMode="decimal" autoComplete="off" pattern="[1-9][0-9]{0,4}\.[0-9]{1,2}\.[0-9]{1,2}" />
          </Field>
          <Field label="Oldest allowed version" htmlFor="app-minimum" hint="Not newer than the newest. 1.0.0 lets every app in." required>
            <Input id="app-minimum" name="minimum" required defaultValue={release?.minimum ?? "1.0.0"} inputMode="decimal" autoComplete="off" pattern="[1-9][0-9]{0,4}\.[0-9]{1,2}\.[0-9]{1,2}" />
          </Field>
          <Field label="Update link" htmlFor="app-url" hint={`Where "Update now" goes. On Google Play: ${PLAY_STORE_URL}`} required>
            <Input id="app-url" name="url" type="url" required defaultValue={release?.url ?? PLAY_STORE_URL} maxLength={2000} autoComplete="off" />
          </Field>
          <div><SubmitButton>Save the versions</SubmitButton></div>
        </form>
      </Card>
    </PageContainer>
  );
}
