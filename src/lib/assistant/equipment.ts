import { profileRefuses } from "@/lib/entitlements";
import type { AssistantIntent, AssistantMachine } from "./types";

/**
 * Support equipment takes only equipment-permitted work (A1; BRIEF section 12, last paragraph;
 * scenario 36), from every channel and on every plan, Complete included. The assistant's write
 * intents and the A1 capability each one records: a fault, a reading and a completed service
 * are maintenance an equipment profile keeps; a diesel draw is fuel, which it does not.
 */
const INTENT_CAPABILITY: Partial<Record<AssistantIntent, "fuel">> = { log_fuel: "fuel" };

/** The A1 refusal code for this intent on this asset, or null when it may be proposed. */
export function equipmentRefusal(
  intent: AssistantIntent | null,
  machine: Pick<AssistantMachine, "profile"> | null | undefined,
): `equipment-refused-${"fuel"}` | null {
  if (!intent || !machine) return null;
  const capability = INTENT_CAPABILITY[intent];
  return capability && profileRefuses(machine.profile ?? "full", capability) ? `equipment-refused-${capability}` : null;
}
