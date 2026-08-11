import { t, type Locale, type Lang, localeOf } from "./i18n";

/**
 * The formatting layer that sits between a query and the screen.
 *
 * The audit's largest repeating pattern — 21 findings — is "the database is showing
 * through": `{current_reading} {meter_type}` printing "184320 km", `vat_rate_bps`
 * asking a farmer for 1500, `<Badge className="capitalize">{u.role}</Badge>` rendering
 * "Rr_admin", and `updated_at.slice(0, 10)` / `toLocaleDateString("en-ZA")` printing ISO
 * dates. Nothing here changes what is stored — readings stay numbers, VAT stays basis
 * points, roles stay enum values. This only decides how they read.
 *
 * South African conventions throughout: a space as the thousands separator (SI/SABS,
 * and unambiguous next to the comma decimal a farmer may type), 24-hour time.
 */

/** Narrow no-break space — keeps "1 240" from wrapping mid-number. */
const NNBSP = " ";

/**
 * A number with thousands separators, e.g. 184320 → "184 320". Fractions are kept to
 * one place because meters read to a tenth; whole numbers stay whole.
 */
export function num(value: number | null | undefined, maxFractionDigits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";

  // Written out rather than delegated to `toLocaleString("en-ZA")`, for the reason set
  // out in `lib/money.ts`: a runtime with trimmed ICU data silently answers in en-US, so
  // the same number renders "184 320,5" on one side and "184,320.5" on the other. The
  // conventions this file exists to enforce cannot depend on the runtime's locale tables.
  const whole = Math.abs(value % 1) < 1e-9;
  const digits = whole ? 0 : maxFractionDigits;
  const fixed = Math.abs(value).toFixed(digits);
  const [intPart, frac] = fixed.split(".");

  let grouped = "";
  for (let i = 0; i < intPart.length; i++) {
    if (i > 0 && (intPart.length - i) % 3 === 0) grouped += NNBSP;
    grouped += intPart[i];
  }

  const sign = value < 0 ? "-" : "";
  return frac ? `${sign}${grouped},${frac}` : `${sign}${grouped}`;
}

/**
 * A meter reading with its unit as a word: 184320 + "km" → "184 320 km",
 * 1240 + "hours" → "1 240 hours". Never prints the column name.
 */
export function meterReading(
  value: number | null | undefined,
  meterType: string | null | undefined,
  locale: Lang,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (meterType === "none" || !meterType) return num(value);
  const unit = t(`format.unit.${meterType}`, locale);
  return `${num(value)}${NNBSP}${unit}`;
}

/** Just the unit word for a meter type ("hours" / "km"), for column headings. */
export function meterUnit(meterType: string | null | undefined, locale: Lang): string {
  if (!meterType || meterType === "none") return "";
  return t(`format.unit.${meterType}`, locale);
}

// ── Dates ────────────────────────────────────────────────────────────────────
// The app stores ISO strings and dates. A person reads "2 days ago" or "12 Mar".

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days between two instants, positive when `then` is in the past. */
export function daysAgo(value: string | Date | null | undefined, now = new Date()): number | null {
  const d = toDate(value);
  if (!d) return null;
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86_400_000);
}

/**
 * "Today" · "Yesterday" · "3 days ago" · "2 weeks ago", falling back to a plain date
 * past a month. Handles the future too ("in 9 days"), which is what every expiry and
 * next-due date on the farm actually needs.
 */
export function relativeDate(
  value: string | Date | null | undefined,
  locale: Lang,
  now = new Date(),
): string {
  const days = daysAgo(value, now);
  if (days == null) return "—";
  if (days === 0) return t("format.today", locale);
  if (days === 1) return t("format.yesterday", locale);
  if (days === -1) return t("format.tomorrow", locale);

  if (days > 1) {
    if (days < 7) return t("format.daysAgo", locale).replace("{n}", String(days));
    if (days < 31) {
      const weeks = Math.round(days / 7);
      return weeks === 1
        ? t("format.lastWeek", locale)
        : t("format.weeksAgo", locale).replace("{n}", String(weeks));
    }
    return shortDate(value, locale);
  }

  const ahead = -days;
  if (ahead < 7) return t("format.inDays", locale).replace("{n}", String(ahead));
  if (ahead < 31) {
    const weeks = Math.round(ahead / 7);
    return weeks === 1
      ? t("format.nextWeek", locale)
      : t("format.inWeeks", locale).replace("{n}", String(weeks));
  }
  return shortDate(value, locale);
}

/** "12 Mar 2026" — a date a person reads, never the ISO string. */
export function shortDate(value: string | Date | null | undefined, locale: Lang): string {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleDateString(localeOf(locale) === "af" ? "af-ZA" : "en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "12 Mar 2026, 14:30" — for an audit trail, where the time matters. */
export function dateTime(value: string | Date | null | undefined, locale: Lang): string {
  const d = toDate(value);
  if (!d) return "—";
  return `${shortDate(d, locale)}, ${d.toLocaleTimeString(localeOf(locale) === "af" ? "af-ZA" : "en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
}

/** "Mar 2026" — for a period heading. */
export function monthLabel(value: string | Date | null | undefined, locale: Lang): string {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleDateString(localeOf(locale) === "af" ? "af-ZA" : "en-ZA", {
    month: "short",
    year: "numeric",
  });
}

// ── VAT ──────────────────────────────────────────────────────────────────────
// The column is `vat_rate_bps` and stays basis points. A farmer reads percent.

/** 1500 → "15%". Display only — the stored value is untouched. */
export function vatPercent(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return "—";
  return `${num(bps / 100)}%`;
}

/** "15" → 1500. For a percent-facing input writing the basis-point column. */
export function percentToBps(input: string | null | undefined): number | null {
  if (input == null) return null;
  const cleaned = String(input).replace(/[%\s]/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// ── Enum labels ──────────────────────────────────────────────────────────────
// Never `capitalize` a raw enum value: that is how "rr_admin" reached a farm's screen
// as "Rr_admin".

/** A person's role in words — "Rapid Rise staff", not "Rr_admin". */
export function roleLabel(role: string | null | undefined, locale: Lang): string {
  if (!role) return "—";
  return t(`role.${role}`, locale);
}

/** Any enum value in words, via its i18n group. Falls back to the raw value. */
export function enumLabel(
  group: string,
  value: string | null | undefined,
  locale: Lang,
): string {
  if (!value) return "—";
  const key = `${group}.${value}`;
  const label = t(key, locale);
  // `t` returns the key itself when the lookup misses — never show a dotted path.
  return label === key ? value.replace(/_/g, " ") : label;
}

/** "3 machines" / "1 machine" — a count with its noun, pluralised. */
export function countLabel(
  n: number,
  singularKey: string,
  pluralKey: string,
  locale: Lang,
): string {
  return t(n === 1 ? singularKey : pluralKey, locale).replace("{n}", num(n, 0));
}
