// High-level capture helpers used by the capture UIs. Online submits take the normal
// server-action / endpoint path unchanged; only when offline (or a submit fails) do we
// queue here with an idempotency UUID + client timestamp and confirm optimistically.

import { idbAvailable } from "./db";
import { enqueue, newMutationId } from "./queue";
import { flush, isOnline } from "./sync";
import type { MutationScope, MutationType, QueuedMutation } from "./types";

export { isOnline } from "./sync";
export { subscribe, pendingCount } from "./queue";

/** IndexedDB present? If not, we can't queue and must stay online-only. */
export function canQueueOffline(): boolean {
  return idbAvailable();
}

/** Queue a mutation for later sync, kicking a flush immediately if we're online. */
export async function queueMutation(input: {
  type: MutationType;
  scope: MutationScope;
  fields: Record<string, string>;
  photo?: Blob;
  voice?: Blob;
}): Promise<QueuedMutation> {
  const m: QueuedMutation = {
    client_id: newMutationId(),
    client_ts: new Date().toISOString(),
    type: input.type,
    scope: input.scope,
    fields: input.fields,
    photo: input.photo,
    voice: input.voice,
    queued_at: Date.now(),
  };
  await enqueue(m);
  if (isOnline()) void flush();
  return m;
}

/** Plain string fields from a form (drops File entries — media is handled separately). */
export function fieldsFromForm(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  new FormData(form).forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}
