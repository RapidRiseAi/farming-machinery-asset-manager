/** South African local numbers are accepted explicitly; other countries need a country code. */
export function phoneNumber(value: string): string | null {
  let number = value.normalize("NFKC").trim();
  if (!/^[+0-9\s().-]+$/.test(number)) return null;
  number = number.replace(/[\s().-]/g, "");
  if (number.startsWith("+")) number = number.slice(1);
  else if (number.startsWith("00")) number = number.slice(2);
  else if (/^0[1-8][0-9]{8}$/.test(number)) number = `27${number.slice(1)}`;
  // +27 (0)82... is a common printed form of the same South African number.
  if (/^270[1-8][0-9]{8}$/.test(number)) number = `27${number.slice(3)}`;
  if (number.startsWith("27") && !/^27[1-8][0-9]{8}$/.test(number)) return null;
  return /^[1-9][0-9]{7,14}$/.test(number) ? number : null;
}
