import { LIMITS } from "@/lib/limits";
import { isUuid } from "@/lib/upload/protocol";

export const CHAT_PAGE = LIMITS.chatPageRows.value;
export const CHAT_BODY = LIMITS.chatBodyChars.value;
export type ChatPerson = { id: string; name: string; admin?: boolean };
export type ChatRoom = { id: string; farm_id: string; title: string; kind: "direct" | "group"; can_write: boolean; members: ChatPerson[] };
export type ChatSummary = { id: string; title: string; kind: "direct" | "group"; people: string[]; unread: number; updated_at: string };
export type ChatAttachment = { id: string; message_id: string; storage_path: string; media_class: "photo" | "pdf" | "voice"; mime: string; bytes: number };
export type ChatMessage = { id: string; sender_id: string; sequence: number; body: string; published_at: string; edited_at: string | null; deleted_at: string | null };
export type Draft = { id: string; body: string };

/** Stable request id survives lost responses and navigation. Drafts are scoped to the login and room. */
export function draftKey(user: string, room: string) { return `fw-chat:${user}:${room}`; }
export function readDraft(value: string | null): Draft | null {
  try {
    const d = JSON.parse(value ?? "null");
    return d && isUuid(d.id) && typeof d.body === "string" && d.body.length <= CHAT_BODY ? { id: d.id, body: d.body } : null;
  } catch { return null; }
}
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map(m => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a,b) => a.sequence - b.sequence);
}
export function parseWrite(value: unknown): { rpc: string; args: Record<string, unknown> } | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  if (b.action === "create") {
    if (!isUuid(b.id) || !isUuid(b.farm) || !["direct","group"].includes(String(b.kind)) ||
      typeof b.title !== "string" || b.title.length > 120 || !Array.isArray(b.people) ||
      b.people.length < 1 || b.people.length >= LIMITS.chatMembers.value || !b.people.every(isUuid)) return null;
    return { rpc: "chat_create", args: { p_id:b.id,p_farm:b.farm,p_kind:b.kind,p_title:b.title,p_people:b.people } };
  }
  if (!isUuid(b.room)) return null;
  if (b.action === "manage") {
    if (!["add","remove","rename"].includes(String(b.operation)) ||
      (b.operation === "rename" ? typeof b.title !== "string" || !b.title.trim() || b.title.length > 120 : !isUuid(b.person))) return null;
    return { rpc:"chat_manage",args:{p_conversation:b.room,p_action:b.operation,p_user:b.person??null,p_title:b.title??null} };
  }
  if (b.action === "read") {
    if (!Number.isSafeInteger(b.sequence) || Number(b.sequence) < 0) return null;
    return {rpc:"chat_mark_read",args:{p_conversation:b.room,p_sequence:b.sequence}};
  }
  if (!isUuid(b.id)) return null;
  if (b.action === "prepare") return {rpc:"chat_prepare",args:{p_conversation:b.room,p_id:b.id}};
  if (!["send","edit","delete"].includes(String(b.action)) || typeof b.body !== "string" || b.body.length>CHAT_BODY) return null;
  return {rpc:b.action === "send"?"chat_send":"chat_edit",args:{p_conversation:b.room,p_id:b.id,p_body:b.body,...(b.action === "send"?{}:{p_delete:b.action === "delete"})}};
}
