/**
 * The website's plan buttons carry the visitor's choice to sign-up (task A5): plan, period,
 * full spaces (`vehicles`) and support equipment. Read here as a STARTING CHOICE only: each
 * value is checked and anything unusable is simply dropped. Nothing activates from a link: the
 * person still confirms the choice, and the server action prices and validates what is
 * finally submitted (A2's create_pending_signup).
 */

export type SignupPrefill = {
  plan?: string;
  period?: "monthly" | "annual";
  vehicles?: number;
  equipment?: number;
};

const MAX_COUNT = 10_000;

function count(raw: unknown, min: number): number | undefined {
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= min && value <= MAX_COUNT ? value : undefined;
}

export function signupPrefill(
  query: Record<string, string | string[] | undefined>,
  sellablePlans: readonly string[],
): SignupPrefill {
  const one = (key: string) => (Array.isArray(query[key]) ? undefined : query[key]) as string | undefined;
  const out: SignupPrefill = {};
  const plan = one("plan");
  if (plan && sellablePlans.includes(plan)) out.plan = plan;
  const period = one("period");
  if (period === "monthly" || period === "annual") out.period = period;
  const vehicles = count(one("vehicles"), 1);
  if (vehicles !== undefined) out.vehicles = vehicles;
  const equipment = count(one("equipment"), 0);
  if (equipment !== undefined) out.equipment = equipment;
  return out;
}
