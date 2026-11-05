import assert from "node:assert/strict";
import test from "node:test";
import { siteUrlWarning } from "./site-url-check";

test("the site address must be the host the app is served from", () => {
  assert.equal(siteUrlWarning("https://app.fleet-wise.co.za", "app.fleet-wise.co.za"), null);
  assert.equal(siteUrlWarning("https://app.fleet-wise.co.za/", "APP.fleet-wise.co.za"), null);
  assert.equal(siteUrlWarning("https://old-name.vercel.app", "app.fleet-wise.co.za"), "site_url_mismatch");
  assert.equal(siteUrlWarning(undefined, "app.fleet-wise.co.za"), "site_url_unset");
  assert.equal(siteUrlWarning("not a url", "app.fleet-wise.co.za"), "site_url_invalid");
  // Local runs and preview deployments are not judged against the production address.
  assert.equal(siteUrlWarning("https://app.fleet-wise.co.za", "localhost:3111"), null);
  assert.equal(siteUrlWarning("https://app.fleet-wise.co.za", "fleetwise-git-x.vercel.app"), null);
  // A proxy's list of hosts: the first is the client's.
  assert.equal(siteUrlWarning("https://app.fleet-wise.co.za", "app.fleet-wise.co.za, internal"), null);
});
