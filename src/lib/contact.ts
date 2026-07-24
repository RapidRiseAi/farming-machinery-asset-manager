/**
 * Provider-free quick-contact deep links (F12a). No WhatsApp Cloud API, no SMS
 * gateway — just links every phone already handles: `tel:`, `https://wa.me/<e164>`
 * and `mailto:`. The full WhatsApp Business integration stays deferred.
 *
 * South-African-aware normalisation: a local `0XX…` number becomes `+27XX…`, a bare
 * `27…` gains its `+`, and anything already in `+…` form is kept. Returns null when
 * there is nothing dial-able, so callers can hide the button.
 */

/** Normalise a raw phone/WhatsApp string to E.164 (e.g. "+27821234567"), or null. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 6) return null; // too short to be a real number

  if (hasPlus) return `+${digits}`;
  // Local SA format: 0XXXXXXXXX (10 digits) → +27XXXXXXXXX
  if (digits.startsWith("0")) return `+27${digits.slice(1)}`;
  // Already a country code without the plus (e.g. 27..., 264...).
  return `+${digits}`;
}

/** `tel:` link for a phone number, or null when not dial-able. */
export function telHref(phone: string | null | undefined): string | null {
  const e164 = toE164(phone);
  return e164 ? `tel:${e164}` : null;
}

/**
 * `https://wa.me/<digits>` deep link with an optional prefilled message. wa.me wants
 * the number WITHOUT the leading `+`. Returns null when there is no usable number.
 */
export function waHref(
  whatsapp: string | null | undefined,
  text?: string | null
): string | null {
  const e164 = toE164(whatsapp);
  if (!e164) return null;
  const num = e164.replace(/^\+/, "");
  const base = `https://wa.me/${num}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

/** `mailto:` link with optional subject/body, or null when there is no address. */
export function mailtoHref(
  email: string | null | undefined,
  subject?: string | null,
  body?: string | null
): string | null {
  const addr = (email ?? "").trim();
  if (!addr || !addr.includes("@")) return null;
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  const qs = params.toString();
  return qs ? `mailto:${addr}?${qs}` : `mailto:${addr}`;
}
