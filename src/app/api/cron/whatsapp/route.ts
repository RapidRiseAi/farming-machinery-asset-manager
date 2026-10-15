import { NextResponse } from "next/server";
import { processWhatsAppInbox, deliverWhatsAppNotifications } from "@/lib/whatsapp/worker";
import { equalSecret } from "@/lib/whatsapp/protocol";
import { createServiceClient } from "@/lib/supabase/service";
import { whatsappEnabled } from "@/lib/whatsapp/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !equalSecret(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    if (whatsappEnabled()) {
      const { error } = await createServiceClient().rpc("whatsapp_prune");
      if (error) throw new Error("whatsapp_prune_failed");
    }
    const [inbox, notifications] = await Promise.all([processWhatsAppInbox(1), deliverWhatsAppNotifications()]);
    return NextResponse.json({ inbox, notifications });
  } catch {
    return NextResponse.json({ error: "whatsapp_worker_failed" }, { status: 503 });
  }
}
