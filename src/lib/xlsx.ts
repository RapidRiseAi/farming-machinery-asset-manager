/**
 * Minimal, dependency-free OOXML (.xlsx) writer — SERVER ONLY.
 *
 * Hand-rolled so the Excel export adds no npm dependency and never ships to the
 * client (imported only from a route handler). Produces a valid multi-sheet
 * SpreadsheetML workbook that opens in Excel / LibreOffice / Google Sheets.
 *
 * House rules (docs/FLEETWISE_BUILD_CHECKLISTS.md §G): money is integer cents
 * ex-VAT everywhere; callers convert to REAL NUMBERS in Rands (cents / 100) and
 * pass `moneyCell(...)` so the cell is a numeric value (formatted 2-decimals),
 * never a string.
 */

export type XlsxCell =
  | null
  | { kind: "text"; value: string; bold?: boolean }
  | { kind: "number"; value: number; money?: boolean };

export type XlsxSheet = { name: string; rows: XlsxCell[][] };

/** A plain text cell. */
export const text = (value: string): XlsxCell => ({ kind: "text", value });
/** A bold header cell. */
export const heading = (value: string): XlsxCell => ({ kind: "text", value, bold: true });
/** A numeric cell (counts, percentages, litres, …). */
export const num = (value: number | null | undefined): XlsxCell =>
  value == null || !Number.isFinite(value) ? null : { kind: "number", value };
/** A money cell: pass integer cents (ex-VAT); stored as a real number in Rands. */
export const moneyCell = (cents: number | null | undefined): XlsxCell =>
  cents == null || !Number.isFinite(cents) ? null : { kind: "number", value: cents / 100, money: true };

// ── XML helpers ──────────────────────────────────────────────────────────────
const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 0 → "A", 25 → "Z", 26 → "AA" … */
function colLetter(i: number): string {
  let n = i;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Excel sheet names: ≤31 chars, none of : \ / ? * [ ] and not empty. */
function sanitizeSheetName(name: string, index: number): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
  return cleaned === "" ? `Sheet${index + 1}` : cleaned;
}

// Style indexes defined in styles.xml below: 0 = default, 1 = bold, 2 = money.
const STYLE_DEFAULT = 0;
const STYLE_BOLD = 1;
const STYLE_MONEY = 2;

function sheetXml(rows: XlsxCell[][]): string {
  const rowXml = rows
    .map((cells, r) => {
      const rowNum = r + 1;
      const cellXml = cells
        .map((cell, c) => {
          if (cell == null) return "";
          const ref = `${colLetter(c)}${rowNum}`;
          if (cell.kind === "number") {
            const style = cell.money ? STYLE_MONEY : STYLE_DEFAULT;
            return `<c r="${ref}" s="${style}"><v>${cell.value}</v></c>`;
          }
          const style = cell.bold ? STYLE_BOLD : STYLE_DEFAULT;
          return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escXml(cell.value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowNum}">${cellXml}</row>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowXml}</sheetData></worksheet>`
  );
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="3">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

// ── ZIP (stored / no compression) ────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type ZipEntry = { name: string; data: Buffer };

function zipStore(entries: ZipEntry[]): Buffer {
  // Fixed, valid DOS date/time (2020-01-01 00:00) — some parsers reject a zero date.
  const dosTime = 0;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const size = e.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + e.data.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/** Build a multi-sheet .xlsx workbook as bytes. Server-only. */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  const named = sheets.map((s, i) => ({ ...s, name: sanitizeSheetName(s.name, i) }));

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    named
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join("") +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    named.map((s, i) => `<sheet name="${escAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 2}"/>`).join("") +
    `</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    named
      .map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("") +
    `</Relationships>`;

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(STYLES_XML, "utf8") },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows), "utf8") })),
  ];

  return zipStore(entries);
}
