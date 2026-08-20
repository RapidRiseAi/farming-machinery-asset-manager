import assert from "node:assert/strict";
import test from "node:test";
import {
  API_RESOURCES,
  PublicApiError,
  apiReadingId,
  apiSelect,
  authenticateApiRequest,
  hashApiToken,
  mintApiToken,
  parseApiListParams,
  parseApiReadingInput,
  parseBearerToken,
  parseIdempotencyKey,
  requireApiScope,
  type ApiContext,
} from "./api-tokens";

const TOKEN = "fwk_TESTliveP_0000000000000000000000000000";
const TOKEN_ID = "8a400000-0000-0000-0000-000000000001";
const FARM_ID = "8a000000-0000-0000-0000-000000000001";
const MACHINE_ID = "8a300000-0000-0000-0000-000000000001";

function context(scopes: ApiContext["scopes"] = ["read"]): ApiContext {
  return {
    tokenId: TOKEN_ID,
    farmId: FARM_ID,
    scopes,
    farmPlan: "done_for_you",
  } as unknown as ApiContext;
}

function apiError(action: () => unknown, code: string): PublicApiError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof PublicApiError);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error("Expected PublicApiError");
}

test("the public read surface stays closed to the six reviewed farm-scoped tables", () => {
  assert.deepEqual(
    Object.values(API_RESOURCES).map((entry) => entry.table),
    [
      "machines",
      "meter_readings",
      "service_plan_lines",
      "faults",
      "job_cards",
      "cost_entries",
    ],
  );
});

test("minting creates a 256-bit secret and returns only its storage-safe representation", () => {
  const minted = mintApiToken(Buffer.alloc(32, 7));
  assert.match(minted.token, /^fwk_[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.tokenHash, hashApiToken(minted.token));
  assert.match(minted.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(minted.prefix, minted.token.slice(0, 12));
  assert.notEqual(minted.tokenHash, minted.token);
});

test("bearer authentication accepts only the Authorization header token shape", () => {
  assert.equal(parseBearerToken(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(parseBearerToken(`bearer ${TOKEN}`), TOKEN);
  assert.equal(apiError(() => parseBearerToken(null), "invalid_token").status, 401);
  apiError(() => parseBearerToken("Basic abc"), "invalid_token");
  apiError(() => parseBearerToken("Bearer fwk_short"), "invalid_token");
  apiError(() => parseBearerToken(`Bearer ${TOKEN} extra`), "invalid_token");
});

test("token resolution derives the farm with no caller-supplied farm id", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = {
    rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return {
        abortSignal: async () => ({
          data: [{
            token_id: TOKEN_ID,
            farm_id: FARM_ID,
            scopes: ["read", "write:readings"],
            farm_plan: "done_for_you",
            api_allowed: true,
          }],
          error: null,
        }),
      };
    },
  };

  const resolved = await authenticateApiRequest(
    new Request("https://fleetwise.test/api/v1/machines?farm_id=attacker", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    client as never,
  );
  assert.equal(resolved.farmId, FARM_ID);
  assert.deepEqual(calls, [{
    name: "api_token_resolve",
    args: { p_token_hash: hashApiToken(TOKEN) },
  }]);
});

test("token resolution accepts canonical PostgreSQL fixture UUIDs without RFC nibbles", async () => {
  const client = {
    rpc() {
      return {
        abortSignal: async () => ({
          data: [{
            token_id: "8a400000-0000-0000-0000-000000000001",
            farm_id: "8a000000-0000-0000-0000-000000000001",
            scopes: ["read"],
            farm_plan: "done_for_you",
            api_allowed: true,
          }],
          error: null,
        }),
      };
    },
  };
  const resolved = await authenticateApiRequest(
    new Request("https://fleetwise.test/api/v1/machines", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    client as never,
  );
  assert.equal(resolved.tokenId, TOKEN_ID);
});

test("unknown tokens and genuine tokens on the wrong plan have different safe errors", async () => {
  const request = new Request("https://fleetwise.test/api/v1/machines", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const client = (data: unknown) => ({
    rpc: () => ({ abortSignal: async () => ({ data, error: null }) }),
  });

  await assert.rejects(
    authenticateApiRequest(request, client([]) as never),
    (error: unknown) => error instanceof PublicApiError && error.status === 401,
  );
  await assert.rejects(
    authenticateApiRequest(
      request,
      client([{
        token_id: TOKEN_ID,
        farm_id: FARM_ID,
        scopes: ["read"],
        farm_plan: "professional",
        api_allowed: false,
      }]) as never,
    ),
    (error: unknown) =>
      error instanceof PublicApiError &&
      error.status === 403 &&
      error.code === "api_plan_required",
  );
});

test("the service-role read chokepoint always applies farm and soft-delete filters", () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const query = {
    select(...args: unknown[]) { calls.push(["select", ...args]); return query; },
    eq(...args: unknown[]) { calls.push(["eq", ...args]); return query; },
    is(...args: unknown[]) { calls.push(["is", ...args]); return query; },
  };
  const client = {
    from(table: string) { calls.push(["from", table]); return query; },
  };

  assert.equal(apiSelect(context(), "machines", client as never), query);
  assert.equal(calls[0][1], "machines");
  assert.ok(calls.some((call) => call[0] === "eq" && call[1] === "farm_id" && call[2] === FARM_ID));
  assert.ok(calls.some((call) => call[0] === "is" && call[1] === "deleted_at" && call[2] === null));
});

test("list parsing accepts PostgreSQL UUIDs and rejects widening or malformed filters", () => {
  const parsed = parseApiListParams(
    new URL(`https://fleetwise.test/api/v1/meter-readings?machine_id=${MACHINE_ID}&limit=25&offset=5`),
    "meter-readings",
  );
  assert.equal(parsed.machineId, MACHINE_ID);
  assert.equal(parsed.limit, 25);
  assert.equal(parsed.offset, 5);

  apiError(
    () => parseApiListParams(new URL(`https://x.test?machine_id=${MACHINE_ID}`), "machines"),
    "invalid_query",
  );
  apiError(
    () => parseApiListParams(new URL(`https://x.test?machine_id=${MACHINE_ID}suffix`), "meter-readings"),
    "invalid_query",
  );
  apiError(() => parseApiListParams(new URL("https://x.test?farm_id=anything"), "machines"), "invalid_query");
  apiError(() => parseApiListParams(new URL("https://x.test?limit=1&limit=2"), "machines"), "invalid_query");
  apiError(() => parseApiListParams(new URL("https://x.test?limit="), "machines"), "invalid_query");
  apiError(() => parseApiListParams(new URL("https://x.test?status="), "machines"), "invalid_query");
  apiError(() => parseApiListParams(new URL("https://x.test?from="), "machines"), "invalid_query");
  apiError(() => parseApiListParams(new URL("https://x.test?from=2026-02-30"), "machines"), "invalid_query");
});

test("reading input accepts canonical PostgreSQL machine IDs but not tenant/source fields", () => {
  assert.deepEqual(
    parseApiReadingInput({ machine_id: MACHINE_ID, reading: 4323.1, reading_date: "2026-08-20" }),
    { machineId: MACHINE_ID, reading: 4323.1, readingDate: "2026-08-20" },
  );
  apiError(
    () => parseApiReadingInput({ machine_id: `${MACHINE_ID}suffix`, reading: 1 }),
    "invalid_body",
  );
  apiError(
    () => parseApiReadingInput({ machine_id: MACHINE_ID, reading: 1, farm_id: FARM_ID }),
    "invalid_body",
  );
  apiError(
    () => parseApiReadingInput({ machine_id: MACHINE_ID, reading: 1, source: "manual" }),
    "invalid_body",
  );
  apiError(
    () => parseApiReadingInput({ machine_id: MACHINE_ID, reading: 1.23 }),
    "invalid_body",
  );
});

test("scope and idempotency controls are explicit and token-namespaced", () => {
  requireApiScope(context(["write:readings"]), "write:readings");
  assert.equal(apiError(() => requireApiScope(context(), "write:readings"), "insufficient_scope").status, 403);

  const request = new Request("https://fleetwise.test/api/v1/meter-readings", {
    headers: { "Idempotency-Key": "telematics-4323" },
  });
  assert.equal(parseIdempotencyKey(request), "telematics-4323");
  const id = apiReadingId(TOKEN_ID, "telematics-4323");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, apiReadingId(TOKEN_ID, "telematics-4323"));
  assert.notEqual(id, apiReadingId("8a400000-0000-0000-0000-000000000002", "telematics-4323"));
  apiError(
    () => parseIdempotencyKey(new Request("https://fleetwise.test/api/v1/meter-readings")),
    "invalid_idempotency_key",
  );
});
