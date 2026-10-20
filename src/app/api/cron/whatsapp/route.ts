import { NextResponse } from "next/server";
import { processWhatsAppInbox, deliverWhatsAppNotifications } from "@/lib/whatsapp/worker";
import { validWorkerAuthorization } from "@/lib/whatsapp/protocol";
import { createServiceClient } from "@/lib/supabase/service";
import { whatsappEnabled } from "@/lib/whatsapp/config";
import { checkWhatsAppConfiguration } from "@/lib/whatsapp/diagnostics";
import { captureError } from "@/lib/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  // The Supabase scheduler gets its own credential, scoped to this route only.
  if (!validWorkerAuthorization(request.headers.get("authorization"),
    [process.env.WHATSAPP_CRON_SECRET, process.env.CRON_SECRET])) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    if (new URL(request.url).searchParams.get("check") === "configuration") {
      return NextResponse.json(await checkWhatsAppConfiguration(), { headers: { "Cache-Control": "private, no-store" } });
    }
    if (whatsappEnabled()) {
      const { error } = await createServiceClient().rpc("whatsapp_prune");
      if (error) throw new Error("whatsapp_prune_failed");
    }
    const [inbox, notifications] = await Promise.all([processWhatsAppInbox(1), deliverWhatsAppNotifications()]);
    return NextResponse.json({ inbox, notifications });
  } catch (error) {
    // Fixed code and type only (the WhatsApp modules log no message text): the run failed
    // every minute with the cause lost.
    captureError(new Error(`whatsapp worker failed (${error instanceof Error ? error.name : typeof error})`), { where: "cron:whatsapp" });
    return NextResponse.json({ error: "whatsapp_worker_failed" }, { status: 503 });
  }
}
