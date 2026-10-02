import { t, type Lang } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";

/**
 * The purchase-order codes that have their own sentence under `po.err.*`. The actions
 * emit them as `po-<code>` (camelCase, e.g. `po-needSupplier`).
 */
const PO_CODES = new Set([
  "alreadyConverted",
  "badStatus",
  "cannotConvert",
  "failed",
  "hasExpense",
  "needAmount",
  "needDescription",
  "needQty",
  "needSupplier",
  "notFound",
]);

/**
 * `?error=` on /orders and /orders/[id], as a sentence in the reader's language.
 *
 * Both pages used to print anything that was not a `po-` code exactly as it arrived,
 * which put raw Postgres messages on screen in English. A known `po-` code gets its own
 * wording; everything else goes through `errorMessage`, which never shows a raw code.
 */
export function poErrorMessage(code: string | string[] | undefined | null, locale: Lang): string | undefined {
  const raw = Array.isArray(code) ? code[0] : code;
  if (!raw) return undefined;
  const slug = raw.startsWith("po-") ? raw.slice("po-".length) : "";
  if (PO_CODES.has(slug)) return t(`po.err.${slug}`, locale);
  return errorMessage(raw, locale);
}
