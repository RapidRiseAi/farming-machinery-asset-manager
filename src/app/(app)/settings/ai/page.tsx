import { currentFarmId, requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { num, shortDate } from "@/lib/format";
import { aiResult } from "@/lib/ai-usage/results";
import { Card, CardTitle } from "@/components/ui/card";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import {
  linkOpenAiKey,
  recheckOpenAiKey,
  removeOpenAiKey,
  setFarmAiLimit,
  setFarmAiSwitches,
  setMemberAiLimit,
} from "./actions";

export const dynamic = "force-dynamic";

/**
 * AI and voice, for the farm's owner (docs/AI_USAGE.md): what this month has cost, by
 * person; the monthly limit at which voice and AI pause; AI help and voice on or off for
 * the farm; and the farm's own OpenAI key.
 *
 * Owner and Rapid Rise only, like billing (docs/BILLING.md section 10): `requireRole`
 * bounces everyone else, and ai_farm_usage refuses anyone who is not the farm's billing
 * admin, so a manager typing the URL gets neither the screen nor the data. Every change
 * is a dialog; the page itself carries no form fields.
 */

type Person = {
  user_id: string;
  name: string;
  voice_seconds: number;
  ai_requests: number;
  billed_cents: number;
  limit_cents: number | null;
};

type Usage = {
  month: string;
  limit_cents: number;
  max_limit_cents: number;
  has_paid: boolean;
  billed_cents: number;
  held_cents: number;
  settings: { ai_enabled: boolean; voice_enabled: boolean; own_key_fallback: "pause" | "platform" } | null;
  key: { hint: string; status: "active" | "invalid" | "no_quota"; checked_at: string } | null;
  people: Person[];
  months: { month: string; billed_cents: number }[];
};

const cents = (value: number) => rands(Math.round(value));
const minutes = (seconds: number) => num(Math.round(Number(seconds) / 6) / 10, 1);

export default async function AiSettingsPage({ searchParams }: { searchParams: Promise<{ ai?: string }> }) {
  // For a farm-side person, requireRole checks the role on the SELECTED farm and returns
  // the profile with that farm in farm_id, so this page and its actions (requireAiAdmin,
  // currentFarmId) always act on the same farm, for owners of several farms too.
  const profile = await requireRole(["owner", "rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const farmId = profile.role === "rr_admin" ? await currentFarmId(profile) : profile.farm_id;
  const header = <PageHeader title={t("aiUsage.title", locale)} lead={t("aiUsage.lead", locale)} locale={locale} />;
  const result = aiResult(sp.ai);
  const flash = result ? (
    <Flash tone={result.tone} message={t(`aiUsage.result.${result.code}`, locale)} clearParams={["ai"]} />
  ) : null;

  if (!farmId) {
    return (
      <PageContainer>
        {header}
        <Card><p className="text-sm text-sand-700">{t("aiUsage.noFarm", locale)}</p></Card>
      </PageContainer>
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ai_farm_usage", { p_farm: farmId });
  if (error || !data) {
    return (
      <PageContainer>
        {header}
        <Card><p className="text-sm text-sand-700">{t("aiUsage.unavailable", locale)}</p></Card>
      </PageContainer>
    );
  }
  const usage = data as Usage;
  const settings = usage.settings ?? { ai_enabled: true, voice_enabled: true, own_key_fallback: "pause" as const };
  const committed = Number(usage.billed_cents) + Number(usage.held_cents);
  const share = usage.limit_cents > 0 ? Math.min(1, committed / usage.limit_cents) : 1;
  const paused = committed >= usage.limit_cents;
  const status = !settings.ai_enabled && !settings.voice_enabled
    ? { tone: "neutral" as const, key: "aiUsage.statusOff" }
    : paused
      ? { tone: "warning" as const, key: "aiUsage.statusPaused" }
      : { tone: "ok" as const, key: "aiUsage.statusOn" };

  return (
    <PageContainer>
      {header}
      {flash}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle>{t("aiUsage.thisMonth", locale)}</CardTitle>
          <Badge tone={status.tone}>{t(status.key, locale)}</Badge>
        </div>
        <StatGrid className="mt-4">
          <Stat label={t("aiUsage.spent", locale)} value={cents(committed)} valueKind="text" />
          <Stat label={t("aiUsage.limit", locale)} value={cents(usage.limit_cents)} valueKind="text" />
        </StatGrid>
        <div
          className="mt-4 h-2 w-full overflow-hidden rounded-full bg-sand-100"
          role="img"
          aria-label={t("aiUsage.barLabel", locale).replace("{percent}", String(Math.round(share * 100)))}
        >
          <div className={paused ? "h-full bg-dangerSolid" : share >= 0.8 ? "h-full bg-gold-500" : "h-full bg-brand-600"} style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
        <p className="mt-3 text-xs leading-5 text-ink-muted">
          {Number(usage.held_cents) > 0
            ? t("aiUsage.heldNote", locale).replace("{held}", cents(usage.held_cents))
            : t("aiUsage.exVatNote", locale)}
        </p>
        {!usage.has_paid ? <p className="mt-1 text-xs leading-5 text-ink-muted">{t("aiUsage.trialNote", locale)}</p> : null}
        <div className="mt-4">
          <DialogForm
            trigger={t("aiUsage.changeLimit", locale)}
            title={t("aiUsage.changeLimitTitle", locale)}
            description={t("aiUsage.changeLimitHelp", locale).replace("{max}", cents(usage.max_limit_cents))}
            closeLabel={t("ui.close", locale)}
            triggerVariant="secondary"
          >
            <form action={setFarmAiLimit}>
              <input type="hidden" name="farm_id" value={farmId} />
              <DialogFields>
                <Field label={t("aiUsage.limitField", locale)} htmlFor="ai-limit">
                  <Input id="ai-limit" name="limit" inputMode="decimal" required defaultValue={String(Math.round(usage.limit_cents / 100))} />
                </Field>
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <SubmitButton>{t("common.save", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        </div>
      </Card>

      <Card>
        <CardTitle>{t("aiUsage.byPerson", locale)}</CardTitle>
        {usage.people.length === 0 ? (
          <p className="mt-2 text-sm text-sand-600">{t("aiUsage.nobodyYet", locale)}</p>
        ) : (
          <Table stacked className="mt-3">
            <Thead>
              <Tr>
                <Th>{t("aiUsage.person", locale)}</Th>
                <Th>{t("aiUsage.voiceMinutes", locale)}</Th>
                <Th>{t("aiUsage.aiRequests", locale)}</Th>
                <Th>{t("aiUsage.cost", locale)}</Th>
                <Th>{t("aiUsage.personalLimit", locale)}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {usage.people.map((person) => (
                <Tr key={person.user_id}>
                  <Td label={t("aiUsage.person", locale)}>{person.name}</Td>
                  <Td label={t("aiUsage.voiceMinutes", locale)}>{minutes(person.voice_seconds)}</Td>
                  <Td label={t("aiUsage.aiRequests", locale)}>{num(Number(person.ai_requests), 0)}</Td>
                  <Td label={t("aiUsage.cost", locale)}>{cents(person.billed_cents)}</Td>
                  <Td label={t("aiUsage.personalLimit", locale)}>
                    <DialogForm
                      trigger={person.limit_cents === null ? t("aiUsage.noPersonalLimit", locale) : cents(person.limit_cents)}
                      triggerLabel={t("aiUsage.setPersonalLimitFor", locale).replace("{name}", person.name)}
                      title={t("aiUsage.personalLimitTitle", locale).replace("{name}", person.name)}
                      description={t("aiUsage.personalLimitHelp", locale)}
                      closeLabel={t("ui.close", locale)}
                      triggerVariant="ghost"
                      triggerSize="sm"
                    >
                      <form action={setMemberAiLimit}>
                        <input type="hidden" name="farm_id" value={farmId} />
                        <input type="hidden" name="user_id" value={person.user_id} />
                        <DialogFields>
                          <Field label={t("aiUsage.limitField", locale)} htmlFor={`limit-${person.user_id}`}>
                            <Input
                              id={`limit-${person.user_id}`}
                              name="limit"
                              inputMode="decimal"
                              defaultValue={person.limit_cents === null ? "" : String(Math.round(person.limit_cents / 100))}
                            />
                          </Field>
                        </DialogFields>
                        <DialogActions cancelLabel={t("common.cancel", locale)}>
                          <SubmitButton>{t("common.save", locale)}</SubmitButton>
                        </DialogActions>
                      </form>
                    </DialogForm>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardTitle>{t("aiUsage.switchesTitle", locale)}</CardTitle>
        <p className="mt-1 text-sm leading-6 text-sand-600">{t("aiUsage.switchesHelp", locale)}</p>
        <dl className="mt-3 divide-y divide-edge-soft">
          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <dt className="text-sm text-sand-800">{t("aiUsage.aiHelp", locale)}</dt>
            <dd><Badge tone={settings.ai_enabled ? "ok" : "neutral"}>{t(settings.ai_enabled ? "aiUsage.on" : "aiUsage.off", locale)}</Badge></dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <dt className="text-sm text-sand-800">{t("aiUsage.voice", locale)}</dt>
            <dd><Badge tone={settings.voice_enabled ? "ok" : "neutral"}>{t(settings.voice_enabled ? "aiUsage.on" : "aiUsage.off", locale)}</Badge></dd>
          </div>
        </dl>
        <div className="mt-3">
          <DialogForm
            trigger={t("aiUsage.changeSwitches", locale)}
            title={t("aiUsage.switchesTitle", locale)}
            closeLabel={t("ui.close", locale)}
            triggerVariant="secondary"
          >
            <form action={setFarmAiSwitches}>
              <input type="hidden" name="farm_id" value={farmId} />
              <DialogFields>
                <Field label={t("aiUsage.aiHelp", locale)} htmlFor="ai-enabled">
                  <Select id="ai-enabled" name="ai_enabled" defaultValue={settings.ai_enabled ? "on" : "off"}>
                    <option value="on">{t("aiUsage.on", locale)}</option>
                    <option value="off">{t("aiUsage.off", locale)}</option>
                  </Select>
                </Field>
                <Field label={t("aiUsage.voice", locale)} htmlFor="voice-enabled">
                  <Select id="voice-enabled" name="voice_enabled" defaultValue={settings.voice_enabled ? "on" : "off"}>
                    <option value="on">{t("aiUsage.on", locale)}</option>
                    <option value="off">{t("aiUsage.off", locale)}</option>
                  </Select>
                </Field>
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <SubmitButton>{t("common.save", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        </div>
      </Card>

      <Card>
        <CardTitle>{t("aiUsage.keyTitle", locale)}</CardTitle>
        <p className="mt-1 text-sm leading-6 text-sand-600">{t("aiUsage.keyHelp", locale)}</p>
        {usage.key ? (
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-sm text-sand-800">
              <span className="font-mono">sk-...{usage.key.hint}</span>{" "}
              <Badge tone={usage.key.status === "active" ? "ok" : "warning"}>{t(`aiUsage.keyStatus.${usage.key.status}`, locale)}</Badge>
            </p>
            <p className="text-xs text-ink-muted">
              {t("aiUsage.keyChecked", locale).replace("{date}", shortDate(usage.key.checked_at, locale))}{" "}
              {t(settings.own_key_fallback === "platform" ? "aiUsage.fallbackPlatform" : "aiUsage.fallbackPause", locale)}
            </p>
            <div className="flex flex-wrap gap-2">
              <form action={recheckOpenAiKey}>
                <input type="hidden" name="farm_id" value={farmId} />
                <SubmitButton variant="secondary" size="sm">{t("aiUsage.checkKey", locale)}</SubmitButton>
              </form>
              <DialogForm
                trigger={t("aiUsage.fallbackChange", locale)}
                title={t("aiUsage.fallbackTitle", locale)}
                closeLabel={t("ui.close", locale)}
                triggerVariant="ghost"
                triggerSize="sm"
              >
                <form action={setFarmAiSwitches}>
                  <input type="hidden" name="farm_id" value={farmId} />
                  <DialogFields>
                    <Field label={t("aiUsage.fallbackTitle", locale)} htmlFor="own-key-fallback">
                      <Select id="own-key-fallback" name="own_key_fallback" defaultValue={settings.own_key_fallback}>
                        <option value="pause">{t("aiUsage.fallbackPauseOption", locale)}</option>
                        <option value="platform">{t("aiUsage.fallbackPlatformOption", locale)}</option>
                      </Select>
                    </Field>
                  </DialogFields>
                  <DialogActions cancelLabel={t("common.cancel", locale)}>
                    <SubmitButton>{t("common.save", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
              <ConfirmDialog
                triggerLabel={t("aiUsage.removeKey", locale)}
                triggerVariant="ghost"
                triggerSize="sm"
                title={t("aiUsage.removeKeyTitle", locale)}
                intro={t("aiUsage.removeKeyHelp", locale)}
                confirmLabel={t("aiUsage.removeKey", locale)}
                cancelLabel={t("common.cancel", locale)}
                action={removeOpenAiKey}
                tone="danger"
              >
                <input type="hidden" name="farm_id" value={farmId} />
              </ConfirmDialog>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <DialogForm
              trigger={t("aiUsage.linkKey", locale)}
              title={t("aiUsage.linkKeyTitle", locale)}
              description={t("aiUsage.linkKeyHelp", locale)}
              closeLabel={t("ui.close", locale)}
              triggerVariant="secondary"
            >
              <form action={linkOpenAiKey}>
                <input type="hidden" name="farm_id" value={farmId} />
                <DialogFields>
                  <Field label={t("aiUsage.keyField", locale)} htmlFor="openai-key">
                    <Input id="openai-key" name="key" type="password" autoComplete="off" spellCheck={false} required placeholder="sk-..." />
                  </Field>
                </DialogFields>
                <DialogActions cancelLabel={t("common.cancel", locale)}>
                  <SubmitButton>{t("aiUsage.linkKeySave", locale)}</SubmitButton>
                </DialogActions>
              </form>
            </DialogForm>
          </div>
        )}
      </Card>

      {usage.months.length > 0 ? (
        <Card>
          <CardTitle>{t("aiUsage.earlierMonths", locale)}</CardTitle>
          <dl className="mt-3 divide-y divide-edge-soft">
            {usage.months.map((month) => (
              <div key={month.month} className="flex items-center justify-between gap-2 py-2">
                <dt className="text-sm text-sand-800">{shortDate(month.month, locale).replace(/^\d+\s/, "")}</dt>
                <dd className="text-sm font-medium tabular-nums text-sand-900">{cents(month.billed_cents)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : null}
    </PageContainer>
  );
}
