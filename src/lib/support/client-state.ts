/**
 * Where a client stands with paying, for Rapid Rise's overview and client page.
 *
 * Read from the subscription (billing_subscriptions, the billing engine's record) and the
 * farm's own status, never from `farms.plan` alone: a plan typed on the farm row says
 * nothing about whether anyone has paid. The same reading `app.farm_billing_gate` makes,
 * in words a person helping a client needs:
 *
 *   paying            active or non-renewing: paid up for this period
 *   grace             past due or in grace: a payment failed and the retries are running
 *   suspended         Rapid Rise suspended or ended the farm, or it was downgraded or
 *                     cancelled for not paying
 *   awaiting_payment  signed up and never paid (pending), or on a trial, which the launch
 *                     offer does not have (founder decision 9)
 *   no_subscription   no subscription row: onboarded before billing existed
 *
 * The seven-day grace rule and recording a payment made outside the app belong to the
 * billing work; when it lands, this is the one place to teach the new states.
 *
 * Plain module so the overview, the client page and the unit test share it.
 */

export type ClientState = "paying" | "grace" | "suspended" | "awaiting_payment" | "no_subscription";

export const CLIENT_STATES: readonly ClientState[] = [
  "paying",
  "grace",
  "awaiting_payment",
  "suspended",
  "no_subscription",
];

export type ClientFarm = { id: string; status: string; is_test: boolean; deleted_at?: string | null };
export type ClientSubscription = { farm_id: string; status: string; created_at: string };

export function clientState(farm: Pick<ClientFarm, "status" | "deleted_at">, sub: Pick<ClientSubscription, "status"> | null): ClientState {
  if (farm.deleted_at || farm.status === "suspended" || farm.status === "cancelled") return "suspended";
  if (!sub) return "no_subscription";
  switch (sub.status) {
    case "active":
    case "non_renewing":
      return "paying";
    case "past_due":
    case "grace":
      return "grace";
    case "downgraded":
    case "cancelled":
      return "suspended";
    default:
      // pending, trialing, or a state this module has not been taught: not paid yet.
      return "awaiting_payment";
  }
}

/** Each farm's latest subscription, as the gate picks it (newest first). */
export function latestSubscriptions<S extends ClientSubscription>(subs: readonly S[]): Map<string, S> {
  const out = new Map<string, S>();
  for (const s of subs) {
    const seen = out.get(s.farm_id);
    if (!seen || Date.parse(s.created_at) > Date.parse(seen.created_at)) out.set(s.farm_id, s);
  }
  return out;
}

/** How many clients are in each state. Test farms only when asked for. */
export function countClientStates(
  farms: readonly ClientFarm[],
  subs: readonly ClientSubscription[],
  includeTest = false,
): Record<ClientState, number> {
  const latest = latestSubscriptions(subs);
  const counts: Record<ClientState, number> = {
    paying: 0,
    grace: 0,
    suspended: 0,
    awaiting_payment: 0,
    no_subscription: 0,
  };
  for (const f of farms) {
    if (f.is_test && !includeTest) continue;
    if (f.deleted_at) continue;
    counts[clientState(f, latest.get(f.id) ?? null)] += 1;
  }
  return counts;
}

/** Days since an ISO instant, or null; a farm quiet for this long needs a call. */
export const QUIET_DAYS = 14;

export function isQuiet(lastActivity: string | null | undefined, now: Date, createdAt?: string | null): boolean {
  const since = lastActivity ?? createdAt ?? null;
  if (!since) return false;
  return now.getTime() - Date.parse(since) >= QUIET_DAYS * 86_400_000;
}
