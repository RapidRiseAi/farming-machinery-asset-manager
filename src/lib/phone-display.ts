/**
 * A phone number as a person reads it, for DISPLAY only.
 *
 * Settings store whatever was typed ("+27825550134", "082 555 0134", "082-555-0134"),
 * and a run of eleven digits is hard to read back to a customer over the counter. South
 * African numbers are grouped the way they are said aloud: "+27 82 555 0134" or
 * "082 555 0134". Anything that is not a recognisable South African number comes back
 * exactly as it was typed, trimmed, because guessing at a foreign format would print a
 * number that is subtly wrong.
 *
 * Never write the result back to the database: inputs stay raw, so a `tel:` link and a
 * WhatsApp deep link keep working from the stored value.
 */
export function formatPhone(raw: string | null | undefined): string {
  const typed = (raw ?? "").trim();
  if (!typed) return "";
  const compact = typed.replace(/[\s().-]/g, "");

  const intl = /^(?:\+|00)?27(\d{9})$/.exec(compact);
  if (intl) return `+27 ${group(intl[1])}`;

  const local = /^0(\d{9})$/.exec(compact);
  if (local) return `0${group(local[1])}`;

  return typed;
}

/** "825550134" to "82 555 0134": area or network code, then three, then four. */
function group(nine: string): string {
  return `${nine.slice(0, 2)} ${nine.slice(2, 5)} ${nine.slice(5)}`;
}
