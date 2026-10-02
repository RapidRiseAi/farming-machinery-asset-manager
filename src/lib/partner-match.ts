/**
 * Is a suggested (global) partner already in this farm's own directory?
 *
 * "Add to my partners" copies a suggested row into the farm. It used to be offered on
 * every suggested row, forever, and a second tap made a second copy. The page and the
 * action both ask this one question, so the button that is hidden and the refusal that
 * guards it can never disagree.
 *
 * Name and phone, both normalised: case and spacing do not matter, and a number written
 * as +27 82 555 0134 is the same number as 082 555 0134.
 */
export function partnerMatchKey(name: string | null | undefined, phone: string | null | undefined): string {
  const n = (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  let digits = (phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("27") && digits.length === 11) digits = `0${digits.slice(2)}`;
  return `${n}|${digits}`;
}
