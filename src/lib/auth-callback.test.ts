import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { missingCodeVerifier } from "./auth-callback";
import { t } from "@/lib/i18n";

test("a link opened without the asking browser's verifier cookie is recognised as such", () => {
  assert.equal(missingCodeVerifier([]), true);
  assert.equal(missingCodeVerifier(["fw_locale", "sb-abcd-auth-token"]), true);
  assert.equal(missingCodeVerifier(["sb-abcd-auth-token-code-verifier"]), false);
  assert.equal(missingCodeVerifier(["sb-abcd-auth-token-code-verifier-x"]), true, "only the exact suffix counts");
});

test("the callback checks for the verifier before the exchange, and says 'other browser', not 'expired'", () => {
  const route = readFileSync(join(process.cwd(), "src/app/auth/callback/route.ts"), "utf8");
  const check = route.indexOf("missingCodeVerifier(names)");
  const exchange = route.indexOf("exchangeCodeForSession");
  assert.ok(check > 0 && exchange > check, "the verifier check must come before the exchange");
  assert.ok(route.includes("/login?error=auth-other-browser"));
  const login = readFileSync(join(process.cwd(), "src/app/(auth)/login/page.tsx"), "utf8");
  assert.ok(login.includes('raw === "auth-other-browser"') && login.includes('t("auth.errOtherBrowser", locale)'));
  for (const lang of ["en", "af"] as const) {
    assert.match(t("auth.errOtherBrowser", lang), /\S/);
    assert.notEqual(t("auth.errOtherBrowser", lang), t("auth.errLinkExpired", lang));
  }
  // The emails' "sent" messages say where to open the link.
  assert.match(t("auth.resetSent", "en"), /same private window/);
  assert.match(t("auth.checkEmail", "en"), /this browser/);
});

test("the email-me-a-link button signs in existing accounts only, back to the configured address", () => {
  const actions = readFileSync(join(process.cwd(), "src/app/(auth)/login/actions.ts"), "utf8");
  const fn = actions.slice(
    actions.indexOf("export async function signInWithMagicLink"),
    actions.indexOf("function noSuchAccount"),
  );
  // A typo must not open an account and email a stranger (5 November).
  assert.match(fn, /^\s+shouldCreateUser: false,$/m, "the option itself, not a comment naming it");
  // The link goes in an email: configuration, never the caller's Origin header.
  assert.match(fn, /const origin = siteUrl\(\);/);
  assert.doesNotMatch(fn, /get\("origin"\)/);
  // "No such account" reads as sent, like a reset: no account-enumeration oracle.
  assert.match(t("auth.checkEmail", "en"), /^If that address has a FLEETWISE account/);
  assert.match(t("auth.checkEmail", "af"), /^As daardie adres 'n FLEETWISE-rekening het/);
});

test("a sign-in link that lands on the front page still finishes signing in", () => {
  const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
  const forward = page.indexOf("redirect(`/auth/callback?code=${encodeURIComponent(code)}`)");
  const sessionCheck = page.indexOf('redirect("/home")');
  assert.ok(forward > 0 && sessionCheck > forward, "the code is forwarded before the signed-in shortcut");
});
