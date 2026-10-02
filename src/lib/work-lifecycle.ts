/** Permissions shared by request forms and server actions. Financial documents belong
 * to the assigned supplier; the customer authorizes and accepts the work. */
export type WorkActor = "owner" | "manager" | "mechanic" | "workshop" | "operator" | "rr_admin" | null;

export function workTransitions(status: string, actor: WorkActor, hasProvider: boolean): string[] {
  if (!hasProvider) return [];
  if (actor === "owner" || actor === "manager") {
    if (["requested", "viewed", "quoted"].includes(status)) return ["accepted"];
    if (status === "invoiced") return ["closed"];
  }
  if (actor === "workshop") {
    if (status === "requested") return ["viewed"];
    if (status === "accepted") return ["in_progress"];
    if (status === "in_progress") return ["completed"];
  }
  return [];
}

export function canRecordWorkAmount(kind: "quote" | "invoice", status: string, actor: WorkActor, hasProvider: boolean): boolean {
  return hasProvider && actor === "workshop" && (kind === "quote"
    ? ["requested", "viewed", "quoted"].includes(status)
    : ["completed", "invoiced"].includes(status));
}

export function canConvertWorkRequest(status: string, actor: WorkActor, hasProvider: boolean): boolean {
  return hasProvider && (actor === "owner" || actor === "manager" || actor === "workshop")
    && ["accepted", "in_progress"].includes(status);
}
