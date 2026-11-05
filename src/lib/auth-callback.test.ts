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
