import "server-only";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/env";
import { runAssistantTurn } from "@/lib/assistant/run-turn";
import { confirmAssistantProposal } from "@/lib/assistant/confirm-proposal";
import { assistantTurnRequestSchema } from "@/lib/assistant/request-schema";
import type { AssistantTurnResponse, AssistantConfirmResponse, AssistantClarification } from "@/lib/assistant/types";
import type { AssistantContext } from "@/lib/assistant/context";
import { loadAssistantMachines } from "@/lib/assistant/data";
import { aiHelpOn, transcriptionVocabulary } from "@/lib/assistant/transcription";
import { t, type Lang } from "@/lib/i18n";
import { whatsappAssistantContext, type WhatsAppLink } from "./identity";
import { whatsappEnabled } from "./config";
import { sendWhatsApp } from "./client";
import { UNSUPPORTED_MESSAGE, replyWindowOpen } from "./protocol";
import { clarificationAnswer, confirmationAction, renderWhatsAppResponse } from "./conversation";
import {
  MAX_IMAGE_BYTES, MAX_VOICE_BYTES, MAX_VOICE_MS, MIN_VOICE_MS, MediaError,
  downloadWhatsAppMedia, expireStagedPhotos, imageMimeFromBytes, oggOpusDurationMs, releasePhoto, stagePhoto,
} from "./media";
import { transcribeVoiceNote } from "./voice";
import { faultLabel, faultListPrompt, isPhotoState, photoPrompt, photoStep, type PhotoFault, type PhotoState } from "./photo-flow";
import { captureError } from "@/lib/observability";

/**
 * Report a failure by a fixed code and the error's type only, never its message: this
 * module's rule is no bodies, tokens or phone numbers in any log, and a provider error's
 * message can carry them. Enough for someone to know the channel is failing.
 */
function reportFailure(where: string, error: unknown) {
  captureError(new Error(`${where} failed (${error instanceof Error ? error.name : typeof error})`), { where });
}

/** The speech call, held here so a test can hear a known transcript without a provider. */
export const workerDeps = { transcribeVoiceNote };

type Inbox = {
  id: string; link_id: string; message_text: string; message_at: string; reply: string | null;
  media_kind?: "audio" | "image" | null; media_id?: string | null; media_mime?: string | null;
};
type Reply = { text: string; pending: unknown };
/** A proposal prepared from a photo conversation carries the staged photo to attach on confirm. */
type WithPhoto = { attachMediaId?: string };

async function deliveryTarget(id: string): Promise<WhatsAppLink | null> {
  const { data, error } = await createServiceClient().rpc("whatsapp_delivery_target", { p_link: id });
  if (error) throw new Error("whatsapp_target_unavailable");
  return data as WhatsAppLink | null;
}

/**
 * A voice note, heard (20261104210000). Returns the transcript, or the reply to send
 * instead when it cannot be heard; the person's AI help, the farm's limits and its own key
 * all apply exactly as they do to a spoken request in the app.
 */
async function hearVoiceNote(context: AssistantContext, item: Inbox, origin: string): Promise<{ text: string } | { reply: string }> {
  const lang = context.profile.lang;
  if (!aiHelpOn(context.profile)) return { reply: t("whatsapp.voiceAiOff", lang).replace("{url}", `${origin}/assistant`) };
  let audio: Uint8Array;
  try {
    audio = await downloadWhatsAppMedia(item.media_id ?? "", MAX_VOICE_BYTES);
  } catch (error) {
    if (error instanceof MediaError && error.code === "media_too_large") return { reply: t("whatsapp.voiceTooLong", lang) };
    reportFailure("whatsapp:voice-download", error);
    return { reply: t("whatsapp.voiceUnavailable", lang) };
  }
  const durationMs = oggOpusDurationMs(audio);
  if (durationMs === null || durationMs < MIN_VOICE_MS) return { reply: t("whatsapp.voiceUnreadable", lang) };
  if (durationMs > MAX_VOICE_MS) return { reply: t("whatsapp.voiceTooLong", lang) };
  let terms: string[] = [];
  try {
    terms = transcriptionVocabulary(await loadAssistantMachines(context.supabase, context.farmId, {
      role: context.role, userId: context.profile.id,
    }));
  } catch {
    // The machine names only sharpen the hearing; it still works without them.
  }
  const heard = await workerDeps.transcribeVoiceNote({
    farmId: context.farmId, userId: context.profile.id, audio, durationMs, terms,
  });
  if (heard.ok) return { text: heard.text.slice(0, 2000) };
  switch (heard.reason) {
    case "not_heard": return { reply: t("whatsapp.voiceNotHeard", lang) };
    case "farm_limit": case "member_limit": return { reply: t("whatsapp.voiceLimit", lang) };
    case "ai_off": return { reply: t("whatsapp.voiceAiOff", lang).replace("{url}", `${origin}/assistant`) };
    case "own_key_broken": return { reply: t("whatsapp.voiceOwnKey", lang).replace("{url}", `${origin}/settings/ai`) };
    default: return { reply: t("whatsapp.voiceUnavailable", lang) };
  }
}

/** Stage an incoming photo and ask what it is for. */
async function receivePhoto(context: AssistantContext, link: WhatsAppLink, item: Inbox, previous: unknown): Promise<Reply> {
  const lang = context.profile.lang;
  let bytes: Uint8Array;
  try {
    bytes = await downloadWhatsAppMedia(item.media_id ?? "", MAX_IMAGE_BYTES);
  } catch (error) {
    if (!(error instanceof MediaError && error.code === "media_too_large")) reportFailure("whatsapp:photo-download", error);
    return { text: t("whatsapp.photoUnreadable", lang), pending: null };
  }
  const mime = imageMimeFromBytes(bytes);
  if (!mime) return { text: t("whatsapp.photoUnreadable", lang), pending: null };
  // A new photo replaces one still waiting for a decision; the old one is removed.
  if (isPhotoState(previous)) await releasePhoto(previous.mediaId, "discarded");
  const staged = await stagePhoto({
    inboxId: item.id, linkId: link.id, farmId: link.farm_id, userId: link.user_id, bytes, mime,
  });
  const caption = item.message_text.trim() || null;
  const state: PhotoState = { kind: "photo", mediaId: staged.id, stage: "choose", caption };
  return { text: photoPrompt(lang, caption), pending: state };
}

/** Open faults this person may see on the linked farm, newest first, under their own access. */
async function openFaults(context: AssistantContext, lang: Lang): Promise<PhotoFault[]> {
  const { data, error } = await context.supabase.from("faults").select("id,machine_id,description")
    .eq("farm_id", context.farmId).in("status", ["open", "in_job", "scheduled"]).is("deleted_at", null)
    .order("created_at", { ascending: false }).limit(9);
  if (error) throw new Error("whatsapp_faults_unavailable");
  const rows = (data ?? []) as { id: string; machine_id: string; description: string | null }[];
  const ids = [...new Set(rows.map((r) => r.machine_id))];
  const names = new Map<string, string>();
  if (ids.length) {
    const machines = await context.supabase.from("machines").select("id,name").in("id", ids);
    if (machines.error) throw new Error("whatsapp_faults_unavailable");
    for (const m of (machines.data ?? []) as { id: string; name: string }[]) names.set(m.id, m.name);
  }
  return rows.map((r) => ({ id: r.id, label: faultLabel(names.get(r.machine_id) ?? null, r.description, lang) }));
}

/**
 * Attach a staged photo to a fault, as the person: the fault must be one they can read,
 * and the attachment row goes in through their own delegated access (the storage object
 * is already in the farm's folder). The staged row's id is the attachment's id, so a
 * replay cannot attach it twice.
 */
async function attachPhoto(context: AssistantContext, mediaId: string, faultId: string): Promise<boolean> {
  const db = createServiceClient();
  const media = await db.from("whatsapp_media").select("id,storage_path,farm_id,state").eq("id", mediaId).maybeSingle();
  if (media.error || !media.data || media.data.farm_id !== context.farmId) return false;
  if (media.data.state === "attached") return true;
  if (media.data.state !== "staged") return false;
  const fault = await context.supabase.from("faults").select("id").eq("id", faultId)
    .eq("farm_id", context.farmId).is("deleted_at", null).maybeSingle();
  if (fault.error || !fault.data) return false;
  const inserted = await context.supabase.from("attachments").insert({
    id: media.data.id, farm_id: context.farmId, parent_type: "fault", parent_id: faultId,
    kind: "photo", storage_path: media.data.storage_path, created_by: context.profile.id,
  });
  if (inserted.error && inserted.error.code !== "23505") return false;
  const settled = await db.from("whatsapp_media").update({
    state: "attached", attachment_id: media.data.id, settled_at: new Date().toISOString(),
  }).eq("id", mediaId).eq("state", "staged");
  return !settled.error;
}

async function runTurn(context: AssistantContext, input: string, clarification?: AssistantClarification): Promise<AssistantTurnResponse> {
  const body = assistantTurnRequestSchema.parse({ input: input.slice(0, 2000), channel: "typed",
    locale: context.profile.language === "af" ? "af-ZA" : "en-ZA", clarification: clarification ?? undefined,
  });
  const response = await runAssistantTurn(context, body);
  return await response.json() as AssistantTurnResponse;
}

/** The photo conversation, one reply at a time (src/lib/whatsapp/photo-flow.ts). */
async function continuePhoto(context: AssistantContext, state: PhotoState, input: string, origin: string): Promise<Reply> {
  const lang = context.profile.lang;
  const step = photoStep(state, input);
  switch (step.do) {
    case "describe":
      return { text: t("whatsapp.photoDescribe", lang), pending: { ...state, stage: "describe" } };
    case "report": {
      const result = await runTurn(context, step.input);
      if (result.kind === "confirm" || result.kind === "clarify") {
        const note = result.kind === "confirm" ? `\n${t("whatsapp.photoOnConfirm", lang)}` : "";
        return { text: renderWhatsAppResponse(result, origin) + note, pending: { ...result, attachMediaId: state.mediaId } };
      }
      // No proposal came of it (a question back, a refusal): the photo keeps waiting.
      return {
        text: `${renderWhatsAppResponse(result, origin)}\n${t("whatsapp.photoDescribe", lang)}`,
        pending: { ...state, stage: "describe" },
      };
    }
    case "list_faults": {
      const faults = await openFaults(context, lang);
      if (!faults.length) return { text: t("whatsapp.photoNoFaults", lang), pending: { ...state, stage: "choose" } };
      return { text: faultListPrompt(lang, faults), pending: { ...state, stage: "pick_fault", faults } };
    }
    case "attach": {
      const ok = await attachPhoto(context, state.mediaId, step.fault.id);
      return {
        text: ok
          ? t("whatsapp.photoAttached", lang).replace("{label}", step.fault.label).replace("{url}", `${origin}/faults`)
          : t("whatsapp.photoAttachFailed", lang).replace("{url}", `${origin}/faults`),
        pending: null,
      };
    }
    case "discard":
      await releasePhoto(state.mediaId, "discarded");
      return { text: t("whatsapp.photoDiscarded", lang), pending: null };
    case "repeat":
      return {
        text: state.stage === "pick_fault" && state.faults?.length ? faultListPrompt(lang, state.faults)
          : state.stage === "describe" ? t("whatsapp.photoDescribe", lang)
          : photoPrompt(lang, state.caption),
        pending: state,
      };
  }
}

async function answer(link: WhatsAppLink, item: Inbox, origin: string): Promise<Reply> {
  const context = await whatsappAssistantContext(link);
  const connect = `${origin}/account/whatsapp`;
  if (!context) return { text: `WhatsApp assistant access needs authorization in Fleetwise. Open ${connect}`, pending: null };
  const lang = context.profile.lang;
  if (!item.media_kind && item.message_text === UNSUPPORTED_MESSAGE) return {
    text: t("whatsapp.unsupported", lang).replace("{url}", `${origin}/assistant`), pending: null,
  };
  // Cached conversation content counts only if it was built under the access held now.
  const current = link.conversation && link.conversation_authority_tag === link.authority_tag
    && link.conversation_at && Date.now() - Date.parse(link.conversation_at) < 10 * 60_000
    ? link.conversation : null;
  let input = item.message_text;
  let heard: string | null = null;
  if (item.media_kind === "audio") {
    const voice = await hearVoiceNote(context, item, origin);
    // Not heard: say why and keep whatever was waiting, so a typed reply can still answer it.
    if ("reply" in voice) return { text: voice.reply, pending: current };
    input = voice.text;
    heard = t("whatsapp.voiceHeard", lang).replace("{text}", voice.text.length > 300 ? `${voice.text.slice(0, 297)}...` : voice.text);
  }
  const reply = await answerInput(context, link, item, input, current, origin);
  return heard ? { ...reply, text: `${heard}\n\n${reply.text}` } : reply;
}

async function answerInput(context: AssistantContext, link: WhatsAppLink, item: Inbox, input: string,
  current: unknown, origin: string): Promise<Reply> {
  const connect = `${origin}/account/whatsapp`;
  if (!item.media_kind || item.media_kind === "audio") {
    if (/^(HELP|HUMAN|SUPPORT)$/i.test(input.trim())) return {
      text: `For help from a person, open Fleetwise support: ${origin}/help. Type NEW to start another request.`, pending: null,
    };
    if (/^NEW$/i.test(input.trim())) {
      const waiting = isPhotoState(current) ? current.mediaId : (current as WithPhoto | null)?.attachMediaId;
      if (waiting) await releasePhoto(waiting, "discarded");
      return { text: "What would you like to ask or record in Fleetwise?", pending: null };
    }
  }
  // A previous proposal may contain costs or machine details the person can no longer
  // read. Live authorization must cover cached conversation content, not just new reads.
  if (link.conversation && link.conversation_authority_tag !== link.authority_tag) return {
    text: `Your Fleetwise access changed. Please start your request again. ${connect}`, pending: null,
  };
  if (item.media_kind === "image") return receivePhoto(context, link, item, current);
  if (isPhotoState(current)) return continuePhoto(context, current, input, origin);
  const pending = current as (AssistantTurnResponse & WithPhoto) | null;
  const attachMediaId = pending?.attachMediaId;
  const action = confirmationAction(input, pending);
  if (action && pending?.kind === "confirm") {
    const result = await confirmAssistantProposal(context, { proposalId: pending.proposal.proposalId, action });
    const body = await result.json() as AssistantConfirmResponse;
    let note = "";
    if (attachMediaId) {
      if (action === "confirm" && body.ok && body.linkedRecordType === "fault") {
        note = await attachPhoto(context, attachMediaId, body.linkedRecordId)
          ? t("whatsapp.photoAttachedToNew", context.profile.lang)
          : t("whatsapp.photoAttachFailed", context.profile.lang).replace("{url}", `${origin}/faults`);
      } else if (!body.ok && action === "confirm") {
        // Not saved: the photo stays staged until the conversation lapses.
      } else {
        await releasePhoto(attachMediaId, "discarded");
        note = t("whatsapp.photoNotKept", context.profile.lang);
      }
    }
    return { text: note ? `${body.message}\n${note}` : body.message, pending: null };
  }
  if (pending?.kind === "confirm") return {
    text: renderWhatsAppResponse(pending, origin) + "\nType NEW to start another request.", pending,
  };
  const clarification = pending?.kind === "clarify" ? clarificationAnswer(input, pending) : undefined;
  if (pending?.kind === "clarify" && !clarification) return { text: renderWhatsAppResponse(pending, origin), pending };
  if (!input.trim()) return { text: "What would you like to ask or record in Fleetwise?", pending: null };
  const result = await runTurn(context, input, clarification ?? undefined);
  const next = ["confirm", "clarify"].includes(result.kind)
    ? (attachMediaId ? { ...result, attachMediaId } : result) : null;
  return { text: renderWhatsAppResponse(result, origin), pending: next };
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
        const result = await answer(link, item, origin);
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

/** Staged photos whose conversation lapsed without a decision: removed, never attached. */
export async function expireWhatsAppPhotos() {
  if (!whatsappEnabled()) return { expired: 0, skipped: true };
  return { expired: await expireStagedPhotos() };
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
