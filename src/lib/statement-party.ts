/**
 * `party=farm:<uuid>` or `party=client:<uuid>`, plus the window.
 *
 * Three routes take the same four query parameters (PDF, CSV, send), and each was
 * validating them itself. Parsing in one place means the validation cannot drift between
 * them — the shape a caller can post to the SEND route is exactly the shape the download
 * route accepts, which matters because one of them emails a customer.
 */
export type StatementParty = {
  key: string;
  farmId: string | null;
  clientId: string | null;
  from: string;
  to: string;
};

const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseStatementParty(params: URLSearchParams): StatementParty | null {
  const key = params.get("party") ?? "";
  const [kind, id] = key.split(":");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  if (!["farm", "client"].includes(kind) || !UUID.test(id ?? "")) return null;
  if (!DATE.test(from) || !DATE.test(to) || from > to) return null;

  return {
    key,
    farmId: kind === "farm" ? id : null,
    clientId: kind === "client" ? id : null,
    from,
    to,
  };
}
