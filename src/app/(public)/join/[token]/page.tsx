import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";

import { APP_NAME } from "@/lib/env";
import { errorMessage } from "@/lib/errors";
import { t, type Locale } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { captureError } from "@/lib/observability";
import { INVITE_CODE_LENGTH, INVITE_TOKEN, JOIN_SENT_COOKIE, hashInviteToken } from "@/lib/partner-invites";
import { createServiceClient } from "@/lib/supabase/service";
import { HeroAside, PublicShell, SplitLayout } from "@/components/public-shell";
import { buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { CheckIcon, JobCardsIcon, MachinesIcon, WarningIcon, WorkIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { claimInvite } from "./actions";

/**
 * Where a contractor lands from a farmer's message.
 *
 * Public, and reading it changes nothing: WhatsApp's preview and mail scanners open every link
 * they are sent. Only `claimInvite`, posted from this page, spends it. Like /verify/[token],
 * the token is matched by its hash through the service role, so an anonymous visitor never
 * reaches the database with their own credentials. It says who sent it and nothing else about
 * the farm until an email address has been proved.
 *
 * This page is also a contractor's first sight of the product, so it sells the partnership
 * as well as doing its job. The hero's points are hidden on a phone, which is where most of
 * these will be opened, so the pitch is its own card under the form.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Access link",
  robots: { index: false, follow: false },
  // The token is in the path: nothing this page loads should be told it.
  referrer: "no-referrer",
};

type Peek = { state: string; farm_name: string; business_name: string };

async function peek(token: string): Promise<Peek | null> {
  if (!INVITE_TOKEN.test(token)) return null;
  const { data, error } = await createServiceClient().rpc("partner_invite_peek", {
    p_token_hash: hashInviteToken(token),
  });
  if (error) {
    captureError(error, { where: "join:peek" });
    return null;
  }
  return ((data as Peek[] | null) ?? [])[0] ?? null;
}

function Pitch({ locale }: { locale: Locale }) {
  const app = (s: string) => s.replaceAll("{app}", () => APP_NAME);
  return (
    <section className="mt-8 rounded-md border border-sand-200 bg-surface p-5 shadow-xs">
      <h3 className="text-lg font-bold text-ink">{app(t("join.pitchTitle", locale))}</h3>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{app(t("join.pitchBody", locale))}</p>
      <Link href="/become-a-partner" className={`mt-4 ${buttonVariants({ variant: "secondary", size: "sm" })}`}>
        {t("join.pitchCta", locale)}
      </Link>
    </section>
  );
}

function Notice({ title, body, tone }: { title: string; body: string; tone: "good" | "stop" }) {
  return (
    <div className="flex items-start gap-3">
      {tone === "good" ? (
        <CheckIcon className="mt-1 shrink-0 text-2xl text-status-ok" />
      ) : (
        <WarningIcon className="mt-1 shrink-0 text-2xl text-status-due" />
      )}
      <div className="min-w-0">
        <h2 className="text-3xl font-bold tracking-tight text-ink">{title}</h2>
        <p className="mt-2 break-words text-lg text-ink-muted">{body}</p>
      </div>
    </div>
  );
}

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; wrong?: string; sent?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const locale = await deviceLocale();
  const invite = await peek(token);
  const state = invite?.state ?? "invalid";
  const farm = invite?.farm_name ?? "";

  const say = (key: string) =>
    t(`join.${key}`, locale)
      .replaceAll("{farm}", () => farm)
      .replaceAll("{business}", () => invite?.business_name ?? "")
      .replaceAll("{app}", () => APP_NAME);

  const sentTo = sp.sent ? (await cookies()).get(JOIN_SENT_COOKIE)?.value : undefined;
  const left = sp.wrong != null ? Number.parseInt(sp.wrong, 10) : null;
  const flash =
    left != null && Number.isFinite(left)
      ? t("join.attemptsLeft", locale).replace("{n}", () => String(left))
      : sp.error
        ? errorMessage(sp.error, locale)
        : undefined;

  const codeField = (
    <Field label={say("code")} htmlFor="join_code" hint={say("codeHint")}>
      <Input
        id="join_code"
        name="code"
        required
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={INVITE_CODE_LENGTH + 2}
      />
    </Field>
  );
  const emailField = (
    <Field label={say("email")} htmlFor="join_email" hint={say("emailHint")}>
      <Input id="join_email" name="email" type="email" inputMode="email" autoComplete="email" required maxLength={200} />
    </Field>
  );

  let content;
  if (sentTo) {
    content = (
      <>
        <Notice tone="good" title={say("sentTitle")} body={say("sentBody").replace("{email}", () => sentTo)} />
        <p className="mt-4 text-sm text-ink-muted">{say("sentWrong")}</p>
      </>
    );
  } else if (state === "open") {
    content = (
      <>
        <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">{say("title")}</h2>
        <p className="mt-2 text-lg text-ink-muted">{say("body")}</p>
        <Flash tone="error" message={flash} className="mt-5" />
        <form action={claimInvite} className="mt-6 space-y-5">
          <input type="hidden" name="token" value={token} />
          {codeField}
          <Field label={say("name")} htmlFor="join_name">
            <Input id="join_name" name="name" autoComplete="name" required maxLength={120} />
          </Field>
          {emailField}
          <SubmitButton size="lg" fullWidth pendingText={say("pending")}>
            {say("submit")}
          </SubmitButton>
        </form>
        <p className="mt-4 text-sm text-ink-muted">{say("safety")}</p>
      </>
    );
  } else if (state === "claimed") {
    content = (
      <>
        <Notice tone="stop" title={say("usedTitle")} body={say("usedBody")} />
        <Flash tone="error" message={flash} className="mt-5" />
        <h3 className="mt-8 text-lg font-bold text-ink">{say("againTitle")}</h3>
        <p className="mt-1 text-sm text-ink-muted">{say("againBody")}</p>
        <form action={claimInvite} className="mt-4 space-y-5">
          <input type="hidden" name="token" value={token} />
          {codeField}
          {emailField}
          <SubmitButton fullWidth pendingText={say("pending")}>
            {say("againSubmit")}
          </SubmitButton>
        </form>
      </>
    );
  } else {
    // The same words for a link that was never real and one somebody typed wrong.
    const key = ["used", "expired", "revoked", "locked"].includes(state) ? state : "invalid";
    content = <Notice tone="stop" title={say(`${key}Title`)} body={say(`${key}Body`)} />;
  }

  return (
    <PublicShell locale={locale} width="full">
      <SplitLayout
        formWidth="md"
        aside={
          <HeroAside
            eyebrow={say("eyebrow")}
            title={say("heroTitle")}
            accent={say("heroAccent")}
            lead={invite ? say("lead") : undefined}
            points={[
              { icon: <MachinesIcon />, title: say("pointVehicles"), body: say("pointVehiclesHint") },
              { icon: <WorkIcon />, title: say("pointRequests"), body: say("pointRequestsHint") },
              { icon: <JobCardsIcon />, title: say("pointDocs"), body: say("pointDocsHint") },
            ]}
          />
        }
      >
        {content}
        <Pitch locale={locale} />
      </SplitLayout>
    </PublicShell>
  );
}
