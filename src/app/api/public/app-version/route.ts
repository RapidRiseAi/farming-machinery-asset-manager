import { NextResponse } from "next/server";

import { deploymentId } from "@/lib/deployment";
import { parseUpdatePolicy, type UpdatePolicy } from "@/lib/native/app-version";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * What an open copy of FLEETWISE asks each time it is opened (28 Nov 2026):
 *
 *   web      the deployment answering now. A page from an older one reloads, or offers to
 *            (DeployWatch), so it never posts a form the site no longer knows.
 *   android  the app versions Rapid Rise set at /admin/app-version (20261128100000). The
 *            Android app compares its own version and asks, or makes, the person update
 *            (NativeUpdateGate).
 *
 * Open to anyone, signed in or not, because the sign-in screen is shown by the app too. It says
 * nothing private: the same answer goes to everyone. Never cached by a browser; the database
 * is asked at most every half minute per server instance, however many phones open the app.
 * When the database does not answer, `android` is null and no phone is asked to update: an app
 * is never locked out because a check failed.
 */
export const dynamic = "force-dynamic";

const FRESH_MS = 30_000;
let held: { at: number; android: UpdatePolicy | null } | null = null;

async function androidPolicy(): Promise<UpdatePolicy | null> {
  if (held && Date.now() - held.at < FRESH_MS) return held.android;
  const { data, error } = await createServiceClient().rpc("native_app_release", { p_platform: "android" });
  if (error) {
    captureError(error, { where: "api:app-version" });
    return held?.android ?? null;
  }
  const android = parseUpdatePolicy(data);
  held = { at: Date.now(), android };
  return android;
}

export async function GET() {
  let android: UpdatePolicy | null = null;
  try {
    android = await androidPolicy();
  } catch (err) {
    captureError(err, { where: "api:app-version" });
  }
  return NextResponse.json(
    { web: deploymentId() || null, android },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
