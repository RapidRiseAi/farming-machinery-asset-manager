import "server-only";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/env";
import { runAssistantTurn } from "@/lib/assistant/run-turn";
import { confirmAssistantProposal } from "@/lib/assistant/confirm-proposal";
import { assistantTurnRequestSchema } from "@/lib/assistant/request-schema";
import type { AssistantTurnResponse, AssistantConfirmResponse } from "@/lib/assistant/types";
import { whatsappAssistantContext, type WhatsAppLink } from "./identity";
import { whatsappEnabled } from "./config";
import { sendWhatsApp } from "./client";
import { replyWindowOpen } from "./protocol";
import { clarificationAnswer, confirmationAction, renderWhatsAppResponse } from "./conversation";
import { captureError } from "@/lib/observability";

/**
 * Report a failure by a fixed code and the error's type only, never its message: this
 * module's rule is no bodies, tokens or phone numbers in any log, and a provider error's
 * message can carry them. Enough for someone to know the channel is failing.
 */
function reportFailure(where: string, error: unknown) {
  captureError(new Error(`${where} failed (${error instanceof Error ? error.name : typeof error})`), { where });
}

type Inbox = { id: string; link_id: string; message_text: string; message_at: string; reply: string | null };

async function deliveryTarget(id: string): Promise<WhatsAppLink | null> {
  const { data, error } = await createServiceClient().rpc("whatsapp_delivery_target", { p_link: id });
  if (error) throw new Error("whatsapp_target_unavailable");
  return data as WhatsAppLink | null;
}

async function answer(link: WhatsAppLink, input: string, origin: string) {
  const context = await whatsappAssistantContext(link);
  const connect = `${origin}/account/whatsapp`;
  if (!context) return { text: `WhatsApp assistant access needs authorization in Fleetwise. Open ${connect}`, pending: null };
  if (input === "[unsupported message]") return {
    text: `Please send a text message. Photos, documents and voice notes currently need Fleetwise: ${origin}/assistant`, pending: null,
  };
  if (/^(HELP|HUMAN|SUPPORT)$/i.test(input.trim())) return {
    text: `For help from a person, open Fleetwise support: ${origin}/help. Type NEW to start another request.`, pending: null,
  };
  if (/^NEW$/i.test(input.trim())) return { text: "What would you like to ask or record in Fleetwise?", pending: null };
  // A previous proposal may contain costs or machine details the person can no longer
  // read. Live authorization must cover cached conversation content, not just new reads.
  if (link.conversation && link.conversation_authority_tag !== link.authority_tag) return {
    text: `Your Fleetwise access changed. Please start your request again. ${connect}`, pending: null,
  };
  const pending = link.conversation_at && Date.now() - Date.parse(link.conversation_at) < 10 * 60_000
    ? link.conversation as AssistantTurnResponse | null : null;
  const action = confirmationAction(input, pending);
  if (action && pending?.kind === "confirm") {
    const result = await confirmAssistantProposal(context, { proposalId: pending.proposal.proposalId, action });
    const body = await result.json() as AssistantConfirmResponse;
    return { text: body.message, pending: null };
  }
  if (pending?.kind === "confirm") return {
    text: renderWhatsAppResponse(pending, origin) + "\nType NEW to start another request.", pending,
  };
  const clarification = pending?.kind === "clarify" ? clarificationAnswer(input, pending) : undefined;
  if (pending?.kind === "clarify" && !clarification) return { text: renderWhatsAppResponse(pending, origin), pending };
  const body = assistantTurnRequestSchema.parse({ input, channel: "typed",
    locale: context.profile.language === "af" ? "af-ZA" : "en-ZA", clarification: clarification ?? undefined,
  });
  const response = await runAssistantTurn(context, body);
  const result = await response.json() as AssistantTurnResponse;
  return { text: renderWhatsAppResponse(result, origin), pending: ["confirm", "clarify"].includes(result.kind) ? result : null };
}

export async function processWhatsAppInbox(limit = 1) {
  if (!whatsappEnabled()) return { processed: 0, skipped: true };
  const origin = siteUrl();
  if (!origin) throw new Error("WhatsApp requires a configured site URL");
  const db = createServiceClient();
  let processed = 0;
  for (let i = 0; i < Math.min(limit, 5); i++) {
    const lease = randomUUID();
    const { data, error } = await db.rpc("whatsapp_claim", { p_lease: lease });
    if (error) throw new Error("whatsapp_claim_failed");
    const item = (data as Inbox[] | null)?.[0];
    if (!item) break;
    try {
      let link = await deliveryTarget(item.link_id);
      if (!link || !replyWindowOpen(item.message_at)) {
        const { error } = await db.from("whatsapp_inbox").update({ state: "cancelled", error_code: "link_or_window_expired" }).eq("id", item.id).eq("lease_id", lease);
        if (error) throw error;
        continue;
      }
      let reply = item.reply;
      const authorityBefore = link.authority_tag;
      if (!reply) {
        const result = await answer(link, item.message_text, origin);
        reply = result.text.slice(0, 4000);
        const saved = await db.rpc("whatsapp_save_reply", {
          p_id: item.id, p_lease: lease, p_reply: reply, p_conversation: result.pending, p_authority_tag: authorityBefore,
        });
        if (saved.error || !saved.data) throw new Error("whatsapp_reply_not_saved");
      }
      // Re-check revocation after model latency and before any data leaves Fleetwise.
      link = await deliveryTarget(item.link_id);
      if (!link || !replyWindowOpen(item.message_at)) continue;
      if (link.authority_tag !== authorityBefore) {
        reply = `Your Fleetwise access changed during this request. Please start again. ${origin}/account/whatsapp`;
        const cleared = await db.from("whatsapp_links").update({ conversation: null, conversation_at: null })
          .eq("id", link.id).eq("lease_id", lease);
        if (cleared.error) throw new Error("whatsapp_access_changed");
      }
      // Revalidate role/assignment on replay: a queued answer must not outlive permission.
      // Ready replies are never retried after a process interruption; require a fresh turn.
      if (item.reply) {
        reply = `Please send your request again so Fleetwise can check your current access. ${origin}/account/whatsapp`;
        const cleared = await db.from("whatsapp_links").update({ conversation: null, conversation_at: null })
          .eq("id", link.id).eq("lease_id", lease);
        if (cleared.error) throw new Error("whatsapp_recovery_failed");
      }
      const claimed = await db.from("whatsapp_inbox").update({ state: "sending" })
        .eq("id", item.id).eq("lease_id", lease).eq("state", "ready").select("id").maybeSingle();
      if (claimed.error || !claimed.data) continue;
      const providerId = await sendWhatsApp(link.phone, { type: "text", text: { body: reply, preview_url: false } });
      const sent = await db.from("whatsapp_inbox").update({ state: "sent", provider_reply_id: providerId })
        .eq("id", item.id).eq("lease_id", lease).eq("state", "sending");
      if (sent.error) throw new Error("whatsapp_delivery_unknown");
      processed++;
    } catch (error) {
      reportFailure("whatsapp:inbox", error);
      // Never blindly retry an ambiguous POST; Meta may already have accepted it.
      await db.from("whatsapp_inbox").update({ state: "failed", error_code: "processing_or_delivery_failed" })
        .eq("id", item.id).eq("lease_id", lease);
    } finally {
      await db.from("whatsapp_links").update({ lease_id: null, lease_until: null }).eq("id", item.link_id).eq("lease_id", lease);
    }
  }
  return { processed };
}

export async function deliverWhatsAppNotifications() {
  if (!whatsappEnabled()) return { sent: 0, skipped: true };
  const template = process.env.WHATSAPP_NOTIFICATION_TEMPLATE;
  const assignmentTemplate = process.env.WHATSAPP_ASSIGNMENT_TEMPLATE;
  if (!template || !assignmentTemplate) return { sent: 0, skipped: true };
  const db = createServiceClient();
  const enqueued = await db.rpc("whatsapp_enqueue_notifications");
  if (enqueued.error) throw new Error("whatsapp_enqueue_failed");
  const { data, error } = await db.from("whatsapp_notification_delivery").select("notification_id,link_id")
    .eq("state", "queued").order("created_at").limit(3);
  if (error) throw new Error("whatsapp_queue_unavailable");
  let sent = 0;
  for (const row of data ?? []) {
    const link = await deliveryTarget(row.link_id);
    const { data: note, error: noteError } = await db.from("notifications").select("template,user_id,farm_id,deleted_at,payload")
      .eq("id", row.notification_id).maybeSingle();
    if (noteError) throw new Error("whatsapp_notification_unavailable");
    let valid = link?.notifications_enabled && note && !note.deleted_at && note.user_id === link.user_id && note.farm_id === link.farm_id;
    if (valid && note?.template === "job_assigned") {
      const job = await db.from("job_cards").select("id").eq("id", note.payload.job_card_id)
        .eq("farm_id", link!.farm_id).eq("mechanic_user_id", link!.user_id).is("deleted_at", null).maybeSingle();
      if (job.error) throw new Error("whatsapp_assignment_unavailable");
      valid = Boolean(job.data);
    }
    if (valid && note?.template === "fault_assigned") {
      const fault = await db.from("faults").select("id").eq("id", note.payload.fault_id)
        .eq("farm_id", link!.farm_id).eq("assigned_to", link!.user_id).is("deleted_at", null).maybeSingle();
      if (fault.error) throw new Error("whatsapp_assignment_unavailable");
      valid = Boolean(fault.data);
    }
    if (!valid || !link || !note) {
      await db.from("whatsapp_notification_delivery").update({ state: "cancelled" }).eq("notification_id", row.notification_id).eq("state", "queued");
      continue;
    }
    const claim = await db.from("whatsapp_notification_delivery").update({ state: "sending" })
      .eq("notification_id", row.notification_id).eq("state", "queued").select("notification_id").maybeSingle();
    if (claim.error) throw new Error("whatsapp_notification_claim_failed");
    if (!claim.data) continue;
    try {
      const id = await sendWhatsApp(link.phone, { type: "template", template: {
        name: ["job_assigned", "fault_assigned"].includes(note.template) ? assignmentTemplate : template,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "en" },
      } });
      const saved = await db.from("whatsapp_notification_delivery").update({ state: "sent", provider_id: id })
        .eq("notification_id", row.notification_id).eq("state", "sending");
      if (saved.error) throw new Error("whatsapp_delivery_unknown");
      sent++;
    } catch (error) {
      reportFailure("whatsapp:notification", error);
      await db.from("whatsapp_notification_delivery").update({ state: "failed", error_code: "delivery_failed_or_unknown" })
        .eq("notification_id", row.notification_id).eq("state", "sending");
    }
  }
  return { sent };
}
