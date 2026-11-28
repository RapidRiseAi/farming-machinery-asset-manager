/**
 * Which deployment of the site this server is (28 Nov 2026). The root layout hands it to the
 * page and /api/public/app-version answers with the current one, so a page that stayed open
 * across a release can tell it is now older than the site (DeployWatch). Vercel names every
 * deployment; the unique deployment address stands in where the id is not set. Empty outside
 * Vercel (a laptop, the tests), which switches the watch off.
 */
export function deploymentId(): string {
  return (process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || "").trim();
}
