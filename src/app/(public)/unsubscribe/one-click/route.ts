import { NextResponse, type NextRequest } from "next/server";

import { turnOffAlertEmails, verifyUnsubscribe } from "@/lib/email/unsubscribe";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * One-click unsubscribe (RFC 8058), the address in an alert email's List-Unsubscribe header.
 *
 * A mail app's own "Unsubscribe" button POSTs here with `List-Unsubscribe=One-Click` in the
 * body and no cookies or origin, so the signed link in the address is the whole authority.
 * The body is not required: the signature is what proves the request, and a provider that
 * sends its form another way must not be turned down. Nothing is in the answer but the status.
 *
 * A mail app that only opens the address in a browser arrives with a GET, and is sent to the
 * page that asks first, so a scanner fetching the link switches nothing off.
 */
export const dynamic = "force-dynamic";

function params(request: NextRequest): { userId: string; signature: string } {
  const url = new URL(request.url);
  return { userId: url.searchParams.get("u") ?? "", signature: url.searchParams.get("s") ?? "" };
}

export async function POST(request: NextRequest) {
  const { userId, signature } = params(request);
  if (!verifyUnsubscribe(userId, signature)) return new NextResponse(null, { status: 400 });
  const result = await turnOffAlertEmails(createServiceClient(), userId);
  if (!result.ok) {
    captureError(new Error("unsubscribe: alert emails not switched off"), { where: "unsubscribe:one-click" });
    // Worth trying again: the provider may retry, and nothing was changed.
    return new NextResponse(null, { status: 503 });
  }
  return new NextResponse(null, { status: 200 });
}

export function GET(request: NextRequest) {
  const { userId, signature } = params(request);
  const page = new URL("/unsubscribe", request.url);
  if (userId) page.searchParams.set("u", userId);
  if (signature) page.searchParams.set("s", signature);
  return NextResponse.redirect(page, 303);
}
