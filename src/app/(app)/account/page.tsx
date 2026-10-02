import { cookies } from "next/headers";
import { t } from "@/lib/i18n";
import { currentPlan, homePathFor, requireProfile } from "@/lib/auth";
import { hourOfDay, quietHoursRange, shortDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import {
  START_COOKIE,
  TABS_COOKIE,
  destinationLabelKey,
  destinationsFor,
  maxTabsFor,
  parseTabs,
  pinnableDestinations,
  resolveStartPath,
  standardHomeFor,
} from "@/lib/preferences";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { FactList, Fact } from "@/components/ui/facts";
import { Flash } from "@/components/ui/flash";
import { Field, TextField } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { PasswordInput } from "@/components/ui/password-input";
import { SubmitButton } from "@/components/ui/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { PushToggle } from "@/components/push/push-toggle";
import { AiConsentControl } from "@/components/assistant/ai-consent-control";
import { PrefRow } from "@/components/preferences/pref-row";
import { ChoiceRadio } from "@/components/preferences/choice-radio";
import { ShortcutPicker } from "@/components/preferences/shortcut-picker";
import { TextSizeControl } from "@/components/preferences/text-size-control";
import { setLanguage, setTone } from "../actions";
import { setNotificationPrefs } from "../notifications/actions";
import {
  changeMyName,
  changeMyEmail,
  changeMyPassword,
  resendVerification,
  setPhoneShortcuts,
  setStartPage,
} from "./actions";

/**
 * Your account and preferences: the one place a person, in any role, changes what is
 * theirs.
 *
 * Until this existed there was no way for anybody to change their own password or email
 * address anywhere in the product, the only `updateUser` call in the codebase was the
 * admin path on the team screen. With password recovery being the magic link, that made a
 * typo'd address at sign-up a permanent lockout that only Rapid Rise could undo.
 *
 * == One hub, every role =======================================================
 * Personal settings used to be spread over four screens, and wording sat on the FARM
 * settings page, which only owners and managers can open, so drivers, mechanics and
 * partners could never choose it. Everything personal is here now, and the page STATES
 * each value with a Change button that opens a dialog: no input box at rest, no primary
 * button competing for the thumb. Theme and text size apply on tap because they belong
 * to this device and are not saved anywhere else; they say so.
 *
 * `email_verified_at` and the alert columns are read here with their own query rather
 * than added to `PROFILE_COLUMNS`: this is the only screen that needs them.
 */
const SAVED: Record<string, string> = {
  name: "account.savedName",
  email: "account.savedEmail",
  password: "account.savedPassword",
  verification: "account.savedVerification",
  language: "ui.saved",
  tone: "ui.saved",
  alerts: "ui.saved",
  start: "ui.saved",
  shortcuts: "ui.saved",
};

/** The role's standard home, named, for "Standard (Dashboard)". */
const HOME_LABEL: Record<string, string> = {
  "/dashboard": "nav.dashboard",
  "/driver": "nav.driverHome",
  "/contractor": "nav.contractor",
  "/admin/farms": "nav.admin",
};

type AccountRow = {
  email_verified_at: string | null;
  notify_inapp: boolean | null;
  notify_push: boolean | null;
  notify_email: boolean | null;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    saved?: string;
    /** Arrived from a password-reset link. The password dialog is why they are here. */
    reset?: string;
  }>;
}) {
  const sp = await searchParams;
  const profile = await requireProfile();
  const locale = profile.lang;

  const supabase = await createClient();
  const [{ data }, farmRes, { plan }, store] = await Promise.all([
    supabase
      .from("users")
      .select("email_verified_at, notify_inapp, notify_push, notify_email, quiet_hours_start, quiet_hours_end")
      .eq("id", profile.id)
      .maybeSingle(),
    profile.farm_id
      ? supabase.from("farms").select("settings").eq("id", profile.farm_id).maybeSingle()
      : Promise.resolve({ data: null }),
    currentPlan(profile),
    cookies(),
  ]);
  const row = (data as AccountRow | null) ?? null;
  const verifiedAt = row?.email_verified_at ?? null;
  const prefs = {
    inapp: row?.notify_inapp ?? true,
    push: row?.notify_push ?? true,
    email: row?.notify_email ?? false,
    quietStart: row?.quiet_hours_start ?? null,
    quietEnd: row?.quiet_hours_end ?? null,
  };
  const farm = ((farmRes.data as { settings: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;
  const farmHour = (k: string, d: number) => (typeof farm[k] === "number" ? (farm[k] as number) : d);
  const farmStart = farmHour("quiet_hours_start", 20);
  const farmEnd = farmHour("quiet_hours_end", 5);
  // The personal window applies only when BOTH ends are set (app.user_deliver_after).
  const ownQuiet = prefs.quietStart != null && prefs.quietEnd != null;

  const destinations = destinationsFor(profile.role, plan);
  const standardHome = homePathFor(profile.role);
  const standardLabel = t(HOME_LABEL[standardHome] ?? "nav.dashboard", locale);
  const startStored = store.get(START_COOKIE)?.value;
  const start = resolveStartPath(startStored, destinations, "");
  const startKey = start ? destinationLabelKey(start, destinations) : null;
  // The same list, cap and parser the app shell draws the phone bar from, so what this
  // page states is exactly what the bar shows. The bar's first tab is always there and
  // is not offered as a pin.
  const pinnable = pinnableDestinations(profile.role, plan);
  const maxTabs = maxTabsFor(profile.role);
  const tabs = parseTabs(store.get(TABS_COOKIE)?.value, pinnable, maxTabs);
  const barHome = standardHomeFor(profile.role, plan);
  const barHomeLabel = t(destinationLabelKey(barHome, destinations) ?? HOME_LABEL[barHome] ?? "nav.dashboard", locale);
  const shortcutsHint = t("account.shortcutsHint", locale)
    .replace("{count}", String(maxTabs))
    .replace("{home}", barHomeLabel);

  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const change = t("account.change", locale);
  const onOff = (on: boolean) => t(on ? "account.on" : "account.off", locale);
  const saveButton = <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>;
  const payer = profile.role === "owner" || profile.role === "manager" || profile.role === "workshop";

  const hours = Array.from({ length: 24 }, (_, h) => h);
  const quietSelect = (name: "quiet_hours_start" | "quiet_hours_end", own: number | null, farmValue: number) => (
    <Select id={name} name={name} defaultValue={own == null ? "" : String(own)}>
      <option value="">{t("account.quietFarmHour", locale).replace("{time}", hourOfDay(farmValue, locale))}</option>
      {hours.map((h) => (
        <option key={h} value={String(h)}>
          {hourOfDay(h, locale)}
        </option>
      ))}
    </Select>
  );

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={t("account.title", locale)}
        lead={t("account.lead", locale)}
        infoKey="account"
        locale={locale}
      />

      {/* The reset link signs them in and lands them here, with the password dialog
          already open. This line stays for when they close it. */}
      {sp.reset ? <Flash tone="info" message={t("account.resetPrompt", locale)} /> : null}
      {sp.saved && SAVED[sp.saved] ? <Flash tone="success" message={t(SAVED[sp.saved], locale)} /> : null}
      {sp.error ? <Flash tone="error" message={errorMessage(sp.error, locale)} /> : null}

      {/* == Who you are ==================================================== */}
      <Card id="profile">
        <CardHeader>
          <CardTitle>{t("account.whoTitle", locale)}</CardTitle>
        </CardHeader>
        <FactList>
          <PrefRow
            label={t("account.nameLabel", locale)}
            value={profile.name}
            action={
              <DialogForm
                trigger={change}
                triggerVariant="secondary"
                triggerSize="sm"
                title={t("account.changeName", locale)}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={changeMyName}>
                  <DialogFields columns={1}>
                    <TextField
                      name="name"
                      label={t("account.nameLabel", locale)}
                      defaultValue={profile.name}
                      required
                      maxLength={120}
                      autoComplete="name"
                    />
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>{saveButton}</DialogActions>
                </form>
              </DialogForm>
            }
          />
          <PrefRow
            label={t("account.emailTitle", locale)}
            value={
              <>
                <span className="break-all">{profile.email ?? "-"}</span>
                {verifiedAt ? (
                  <span className="mt-0.5 block text-xs font-normal text-status-ok">
                    {t("account.verified", locale).replace("{date}", shortDate(verifiedAt, locale))}
                  </span>
                ) : (
                  <>
                    <span className="mt-0.5 block text-xs font-normal text-status-due">
                      {t("account.unverified", locale)}
                    </span>
                    <form action={resendVerification} className="mt-2">
                      <SubmitButton variant="ghost" size="sm">
                        {t("account.resend", locale)}
                      </SubmitButton>
                    </form>
                  </>
                )}
              </>
            }
            action={
              <DialogForm
                trigger={change}
                triggerVariant="secondary"
                triggerSize="sm"
                title={t("account.changeEmailTitle", locale)}
                description={t(payer ? "account.emailWhy" : "account.emailWhyCrew", locale)}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={changeMyEmail}>
                  <DialogFields columns={1}>
                    <TextField
                      name="email"
                      type="email"
                      label={t("account.newEmailLabel", locale)}
                      hint={t("account.newEmailHint", locale)}
                      required
                      autoComplete="email"
                    />
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{t("account.changeEmail", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            }
          />
          <PrefRow
            label={t("account.passwordTitle", locale)}
            value={<span className="font-normal text-sand-600">{t("account.passwordWhy", locale)}</span>}
            action={
              <DialogForm
                trigger={change}
                triggerVariant="secondary"
                triggerSize="sm"
                title={t("account.changePasswordTitle", locale)}
                description={sp.reset ? t("account.resetPrompt", locale) : undefined}
                closeLabel={closeLabel}
                size="md"
                defaultOpen={Boolean(sp.reset)}
              >
                <form action={changeMyPassword}>
                  <DialogFields columns={1}>
                    <Field label={t("account.newPassword", locale)} hint={t("account.passwordHint", locale)} htmlFor="password">
                      <PasswordInput
                        id="password"
                        name="password"
                        minLength={8}
                        required
                        autoComplete="new-password"
                        revealLabel={t("auth.revealPassword", locale)}
                      />
                    </Field>
                    <Field label={t("account.newPasswordAgain", locale)} htmlFor="password_again">
                      <PasswordInput
                        id="password_again"
                        name="password_again"
                        minLength={8}
                        required
                        autoComplete="new-password"
                        revealLabel={t("auth.revealPassword", locale)}
                      />
                    </Field>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{t("account.changePassword", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            }
          />
        </FactList>
      </Card>

      {/* == Language and wording, for every role =========================== */}
      <Card id="language">
        <CardHeader>
          <CardTitle>{t("account.languageTitle", locale)}</CardTitle>
        </CardHeader>
        <FactList>
          <PrefRow
            label={t("nav.language", locale)}
            value={t(profile.language === "en" ? "settings.english" : "settings.afrikaans", locale)}
            hint={t("account.languageHint", locale)}
            action={
              <DialogForm
                trigger={change}
                triggerVariant="secondary"
                triggerSize="sm"
                title={t("account.changeLanguage", locale)}
                description={t("account.languageHint", locale)}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={setLanguage}>
                  <input type="hidden" name="next" value="/account?saved=language#language" />
                  <fieldset className="flex flex-col gap-2">
                    <legend className="sr-only">{t("nav.language", locale)}</legend>
                    <ChoiceRadio name="lang" value="en" label={t("settings.english", locale)} defaultChecked={profile.language === "en"} />
                    <ChoiceRadio name="lang" value="af" label={t("settings.afrikaans", locale)} defaultChecked={profile.language === "af"} />
                  </fieldset>
                  <DialogActions cancelLabel={cancelLabel}>{saveButton}</DialogActions>
                </form>
              </DialogForm>
            }
          />
          <PrefRow
            label={t("account.wordingLabel", locale)}
            value={t(profile.tone === "professional" ? "settings.toneProfessional" : "settings.toneFriendly", locale)}
            hint={t(profile.tone === "professional" ? "settings.toneProfessionalEg" : "settings.toneFriendlyEg", locale)}
            action={
              <DialogForm
                trigger={change}
                triggerVariant="secondary"
                triggerSize="sm"
                title={t("account.changeWording", locale)}
                description={t("settings.toneHint", locale)}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={setTone}>
                  <input type="hidden" name="next" value="/account?saved=tone#language" />
                  <fieldset className="flex flex-col gap-2">
                    <legend className="sr-only">{t("account.wordingLabel", locale)}</legend>
                    <ChoiceRadio
                      name="tone"
                      value="friendly"
                      label={t("settings.toneFriendly", locale)}
                      hint={t("settings.toneFriendlyEg", locale)}
                      defaultChecked={profile.tone !== "professional"}
                    />
                    <ChoiceRadio
                      name="tone"
                      value="professional"
                      label={t("settings.toneProfessional", locale)}
                      hint={t("settings.toneProfessionalEg", locale)}
                      defaultChecked={profile.tone === "professional"}
                    />
                  </fieldset>
                  <DialogActions cancelLabel={cancelLabel}>{saveButton}</DialogActions>
                </form>
              </DialogForm>
            }
          />
        </FactList>
      </Card>

      {/* == Appearance, on this device only =================================
          Stored in this browser, applied on tap, and never saved to the account: the
          phone in the cab and the office screen want different things. */}
      <Card id="appearance">
        <CardHeader>
          <CardTitle>{t("account.appearanceTitle", locale)}</CardTitle>
        </CardHeader>
        <p className="text-sm text-sand-600">{t("account.appearanceHint", locale)}</p>
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-sand-800">{t("account.themeLabel", locale)}</p>
            <ThemeToggle
              variant="segmented"
              label={t("account.themeLabel", locale)}
              labels={{
                system: t("nav.themeSystem", locale),
                light: t("nav.themeLight", locale),
                dark: t("nav.themeDark", locale),
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-sand-800">{t("account.textSize", locale)}</p>
            <TextSizeControl
              label={t("account.textSize", locale)}
              labels={{
                normal: t("account.textNormal", locale),
                large: t("account.textLarge", locale),
                larger: t("account.textLarger", locale),
              }}
            />
          </div>
        </div>
      </Card>

      {/* == Alerts ========================================================== */}
      <Card id="alerts">
        <CardHeader
          action={
            <DialogForm
              trigger={change}
              triggerVariant="secondary"
              triggerSize="sm"
              title={t("account.alertsChange", locale)}
              closeLabel={closeLabel}
              size="md"
            >
              <form action={setNotificationPrefs}>
                <DialogFields columns={1}>
                  <fieldset>
                    <legend className="text-sm font-semibold text-sand-800">{t("account.channelsSection", locale)}</legend>
                    <Checkbox name="notify_inapp" defaultChecked={prefs.inapp} label={t("prefs.inapp", locale)} />
                    <Checkbox name="notify_push" defaultChecked={prefs.push} label={t("prefs.push", locale)} />
                    <Checkbox
                      id="notify_email"
                      name="notify_email"
                      defaultChecked={prefs.email}
                      label={t("prefs.email", locale)}
                      hint={t("prefs.emailHint", locale)}
                    />
                  </fieldset>
                  <fieldset className="flex flex-col gap-2">
                    <legend className="text-sm font-semibold text-sand-800">{t("prefs.quietHours", locale)}</legend>
                    <p className="text-xs text-sand-500">{t("prefs.quietHoursHint", locale)}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label={t("prefs.quietStart", locale)} htmlFor="quiet_hours_start">
                        {quietSelect("quiet_hours_start", prefs.quietStart, farmStart)}
                      </Field>
                      <Field label={t("prefs.quietEnd", locale)} htmlFor="quiet_hours_end">
                        {quietSelect("quiet_hours_end", prefs.quietEnd, farmEnd)}
                      </Field>
                    </div>
                  </fieldset>
                </DialogFields>
                <DialogActions cancelLabel={cancelLabel}>{saveButton}</DialogActions>
              </form>
            </DialogForm>
          }
        >
          <CardTitle>{t("account.alertsTitle", locale)}</CardTitle>
        </CardHeader>
        <FactList>
          <Fact label={t("account.inApp", locale)} value={onOff(prefs.inapp)} muted={!prefs.inapp} />
          <Fact label={t("account.push", locale)} value={onOff(prefs.push)} muted={!prefs.push} />
          <Fact label={t("account.email", locale)} value={onOff(prefs.email)} muted={!prefs.email} />
          <Fact
            label={t("prefs.quietHours", locale)}
            value={
              ownQuiet
                ? quietHoursRange(prefs.quietStart, prefs.quietEnd, locale)
                : t("account.quietFarm", locale).replace("{range}", quietHoursRange(farmStart, farmEnd, locale))
            }
            hint={t("account.quietUrgent", locale)}
          />
        </FactList>
        {/* Push has two halves: the account's switch above, and whether THIS device ever
            subscribed. Only the browser knows the second, so it is its own row. */}
        <div className="mt-3 border-t border-sand-100 pt-3">
          <PushToggle locale={locale} bare accountPushOn={prefs.push} />
        </div>
      </Card>

      {/* Withdrawal stays reachable without the assistant plan, under the same opt-in
          condition it always had. */}
      {profile.ai_processing_opt_in ? (
        <Card id="ai">
          <AiConsentControl locale={locale} />
        </Card>
      ) : null}

      {/* == Start page and phone shortcuts, on this device =================== */}
      <Card id="shortcuts">
        <CardHeader>
          <CardTitle>{t("account.startTitle", locale)}</CardTitle>
        </CardHeader>
        <FactList>
          <PrefRow
            label={t("account.startPage", locale)}
            value={
              startKey
                ? t(startKey, locale)
                : t("account.startStandard", locale).replace("{page}", standardLabel)
            }
            hint={t("account.startHint", locale)}
            action={
              <DialogForm
                trigger={change}
                triggerVariant="secondary"
                triggerSize="sm"
                title={t("account.changeStart", locale)}
                description={t("account.startHint", locale)}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={setStartPage}>
                  <fieldset className="flex flex-col gap-2">
                    <legend className="sr-only">{t("account.startPage", locale)}</legend>
                    <ChoiceRadio
                      name="start"
                      value=""
                      label={t("account.startStandard", locale).replace("{page}", standardLabel)}
                      defaultChecked={!start}
                    />
                    {destinations
                      .filter((d) => d.href !== standardHome)
                      .map((d) => (
                        <ChoiceRadio
                          key={d.href}
                          name="start"
                          value={d.href}
                          label={t(d.labelKey, locale)}
                          defaultChecked={start === d.href}
                        />
                      ))}
                  </fieldset>
                  <DialogActions cancelLabel={cancelLabel}>{saveButton}</DialogActions>
                </form>
              </DialogForm>
            }
          />
          <PrefRow
            label={t("account.shortcuts", locale)}
            value={
              tabs.length
                ? tabs.map((h) => t(destinationLabelKey(h, pinnable) ?? "nav.machines", locale)).join(", ")
                : t("account.shortcutsStandard", locale)
            }
            muted={!tabs.length}
            hint={shortcutsHint}
            action={
              <DialogForm
                trigger={change}
                triggerVariant="secondary"
                triggerSize="sm"
                title={t("account.changeShortcuts", locale)}
                description={shortcutsHint}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={setPhoneShortcuts}>
                  <ShortcutPicker
                    options={pinnable.map((d) => ({ href: d.href, label: t(d.labelKey, locale) }))}
                    initial={tabs}
                    max={maxTabs}
                  />
                  <DialogActions cancelLabel={cancelLabel}>
                    {tabs.length ? (
                      <button type="submit" name="reset" value="1" className={buttonVariants({ variant: "ghost" })}>
                        {t("account.shortcutsReset", locale)}
                      </button>
                    ) : null}
                    {saveButton}
                  </DialogActions>
                </form>
              </DialogForm>
            }
          />
        </FactList>
      </Card>
    </PageContainer>
  );
}
