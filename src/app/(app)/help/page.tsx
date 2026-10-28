import Link from "next/link";

import { accessibleFarms, currentFarmId, effectiveFarmRole, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { must, soft } from "@/lib/supabase/must";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { dateTime } from "@/lib/format";
import { COMPANY } from "@/lib/legal";

import { Card, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { Disclosure } from "@/components/ui/disclosure";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { backHref } from "@/components/ui/back-href";
import { ChatIcon } from "@/components/ui/icons";
import { ContactCard, CustomerStatusBadge, type SupportContact } from "@/components/support/support-parts";

import { askForHelp } from "./actions";

export const dynamic = "force-dynamic";

type HelpRequest = {
  id: string;
  subject: string;
  kind: string;
  status: "open" | "waiting" | "resolved" | "closed";
  created_at: string;
  resolved_at: string | null;
  mine: boolean;
  asked_by_name: string | null;
  farm_id: string | null;
  farm_name: string | null;
  answered: boolean;
};

type FarmChoice = { id: string; name: string };

/**
 * The quick answers, per role, built from the "What is this?" copy the screens already
 * carry. A driver asks how to report a problem or write down diesel; an owner asks what
 * the dashboard and the calendar are for. Nothing new to keep in step.
 */
const QUICK_ANSWERS: Record<"operator" | "other", readonly string[]> = {
  operator: ["driver", "faults", "checklists", "fuel"],
  other: ["dashboard", "faults", "machines", "calendar", "fuel"],
};

/**
 * Asking Rapid Rise for help without leaving the product, and reading the answer here.
 *
 * == Answers first, the form behind a button ================================
 * The quick answers come first; asking us is the header's one button, and its form opens
 * in a dialog. Each request opens its own page with the conversation and a reply box.
 *
 * == Anybody signed in may ask ================================================
 * Any farm member, a driver included, and contractors too (about their own business or a
 * farm they work for). Somebody with more than one farm chooses which one it is about.
 *
 * == What you have asked ======================================================
 * Your OWN requests. The owner and managers of the selected farm also see the farm's
 * other requests (not an employee's privacy request), marked with who asked; nobody sees
 * another farm's (`my_help_requests`, 20261028100900).
 *
 * == How to reach a person ====================================================
 * The hours and the same-day promise come from the support settings row, as do the phone
 * and WhatsApp numbers, which stay hidden until Rapid Rise has confirmed and entered them.
 *
 * == What is attached =========================================================
 * The farm, its plan, who asked and the screen they came from. Never card or billing
 * details: the billing dossier built for disputes is not attached to a question.
 */
export default async function HelpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; from?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;
  const isWorkshop = profile.role === "workshop";

  const supabase = await createClient();
  const selectedFarm = isWorkshop ? null : await currentFarmId(profile);
  const role = selectedFarm ? await effectiveFarmRole(selectedFarm, profile) : null;
  const canSeeFarm = role === "owner" || role === "manager";

  // must: a failed read showed "no requests" to somebody waiting on an answer.
  const data = must(await supabase.rpc("my_help_requests", { p_farm: canSeeFarm ? selectedFarm : null }), "help:my-requests");
  const requests = (data as HelpRequest[] | null) ?? [];
  // soft: only the hours and the channels; the founder's defaults stand in for them.
  const contactRows = soft(await supabase.rpc("support_contact"), "help:contact");
  const contact = ((contactRows as SupportContact[] | null) ?? [])[0] ?? null;

  // Which farm it is about. A contractor may ask about a linked farm or their own
  // business (the empty choice); a member of several farms picks one, the selected one first.
  let farms: FarmChoice[] = [];
  if (isWorkshop) {
    const links = must(
      await supabase.from("workshop_links").select("farm_id, farms(id, name)").eq("status", "active").is("deleted_at", null),
      "help:linked-farms",
    );
    farms = ((links as { farm_id: string; farms: { id: string; name: string } | { id: string; name: string }[] | null }[] | null) ?? [])
      .flatMap((l) => (Array.isArray(l.farms) ? l.farms : l.farms ? [l.farms] : []))
      .map((f) => ({ id: f.id, name: f.name }));
  } else {
    farms = await accessibleFarms(profile);
  }
  const farmChoices = isWorkshop ? farms : farms.length > 1 ? farms : [];
  const multiFarm = new Set(requests.map((r) => r.farm_id ?? "")).size > 1;

  const openCount = requests.filter((r) => r.mine && (r.status === "open" || r.status === "waiting")).length;
  const atLimit = openCount >= 5;

  // Back to wherever they came from, when that is a real same-origin path.
  const from = backHref(sp.from, "");
  const back = from && !from.startsWith("/help") ? { href: from, label: t("help.backWhereYouWere", locale) } : undefined;
  const answers = QUICK_ANSWERS[profile.role === "operator" ? "operator" : "other"];

  const askDialog = (
    <DialogForm
      trigger={t("help.askTitle", locale)}
      triggerIcon={<ChatIcon />}
      title={t("help.askTitle", locale)}
      description={t("help.lead", locale)}
      closeLabel={t("ui.close", locale)}
      size="md"
    >
      <form action={askForHelp}>
        <RequestIdInput action="help:ask" />
        {/* Where they came from, so the first reply is not "which screen were you on".
            Validated as a relative path in the action, and the database keeps only three
            named keys whatever this posts. */}
        <input type="hidden" name="path" value={sp.from ?? "/help"} />
        <DialogFields columns={1}>
          <Field label={t("support.askKind", locale)} htmlFor="help-kind">
            <Select id="help-kind" name="kind" defaultValue="help_request">
              <option value="help_request">{t("support.askKindQuestion", locale)}</option>
              <option value="privacy_request">{t("support.askKindPrivacy", locale)}</option>
              {!isWorkshop && canSeeFarm ? (
                <option value="export_request">{t("support.askKindExport", locale)}</option>
              ) : null}
            </Select>
          </Field>
          {farmChoices.length > 0 ? (
            <Field label={t("support.askFarm", locale)} htmlFor="help-farm">
              <Select id="help-farm" name="farm_id" defaultValue={isWorkshop ? "" : selectedFarm ?? ""}>
                {isWorkshop ? <option value="">{t("support.askFarmOwnBusiness", locale)}</option> : null}
                {farmChoices.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </Select>
            </Field>
          ) : selectedFarm ? (
            <input type="hidden" name="farm_id" value={selectedFarm} />
          ) : null}
          <Field
            label={t("help.subject", locale)}
            htmlFor="help-subject"
            hint={t("help.subjectHint", locale)}
            required
          >
            <Input id="help-subject" name="subject" required maxLength={200} />
          </Field>
          <Field
            label={t("help.message", locale)}
            htmlFor="help-message"
            hint={t("help.messageHint", locale)}
            required
          >
            <Textarea id="help-message" name="message" required rows={5} maxLength={4000} />
          </Field>
        </DialogFields>
        <DialogActions cancelLabel={t("common.cancel", locale)} note={t("support.attachNote", locale)}>
          <SubmitButton variant="primary">{t("help.send", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={t("help.title", locale)}
        lead={t("help.leadAnswers", locale)}
        infoKey="help"
        locale={locale}
        back={back}
        actions={atLimit ? undefined : askDialog}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("help.sent", locale) : undefined} />

      <section className="flex flex-col gap-2" aria-labelledby="help-quick">
        <h2 id="help-quick" className="text-base font-bold text-sand-900">{t("help.quickTitle", locale)}</h2>
        {answers.map((key) => (
          <Disclosure key={key} summary={t(`pageInfo.${key}Title`, locale)}>
            <div className="flex flex-col gap-2 text-sm leading-relaxed text-sand-700">
              <p>{t(`pageInfo.${key}What`, locale)}</p>
              <p>{t(`pageInfo.${key}Does`, locale)}</p>
            </div>
          </Disclosure>
        ))}
      </section>

      {requests.length > 0 ? (
        <Card flush>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <CardTitle>{t(canSeeFarm ? "support.yoursAndFarmTitle" : "help.yoursTitle", locale)}</CardTitle>
          </div>
          <ul className="divide-y divide-sand-200">
            {requests.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/help/${r.id}`}
                  className="focus-ring flex flex-wrap items-start justify-between gap-2 p-4 hover:bg-surface-hover sm:p-5"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium text-ink">{r.subject}</p>
                    <p className="mt-0.5 text-xs text-sand-600">
                      {t("help.askedOn", locale).replace("{when}", dateTime(r.created_at, locale))}
                      {!r.mine && r.asked_by_name ? ` · ${t("support.askedBy", locale).replace("{name}", r.asked_by_name)}` : ""}
                      {multiFarm && r.farm_name ? ` · ${r.farm_name}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r.kind !== "help_request" ? <Badge tone="info">{t(`support.kind.${r.kind}`, locale)}</Badge> : null}
                    {r.answered && (r.status === "open" || r.status === "waiting") ? (
                      <Badge tone="ok">{t("support.newAnswer", locale)}</Badge>
                    ) : null}
                    <CustomerStatusBadge status={r.status} locale={locale} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {atLimit ? (
            <p className="border-t border-sand-200 p-4 text-sm text-sand-600 sm:p-5">
              {t("help.atLimit", locale)}
            </p>
          ) : null}
        </Card>
      ) : null}

      {/* Email stays, for anybody who would rather, and for anybody who cannot sign in at
          all. Taking it away would make a locked-out customer worse off. */}
      <ContactCard contact={contact} fallbackEmail={COMPANY.email} locale={locale} />
    </PageContainer>
  );
}
