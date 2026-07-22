import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";

// A4 in points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - 2 * MARGIN;

const INK = rgb(0.15, 0.13, 0.11);
const MUTED = rgb(0.42, 0.39, 0.34);
const RULE = rgb(0.9, 0.88, 0.84);
const BRAND = rgb(0.08, 0.5, 0.24);

// Characters pdf-lib's WinAnsi encoding can't render → safe replacements.
const MAP: Record<string, string> = { "→": "->", "←": "<-", "•": "-", "ℓ": "L", "☑": "[x]", "☐": "[ ]", "✓": "x", "🚜": "" };
const EXTRA = new Set([0x2018, 0x2019, 0x201c, 0x201d, 0x2013, 0x2014, 0x2026, 0x2022, 0x20ac, 0x2122]);

/** Replace glyphs outside WinAnsi so drawText never throws. */
export function sanitize(s: string | null | undefined): string {
  if (s == null) return "";
  let out = "";
  for (const ch of String(s)) {
    if (ch in MAP) { out += MAP[ch]; continue; }
    const code = ch.codePointAt(0) ?? 0;
    out += (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || EXTRA.has(code) ? ch : "?";
  }
  return out;
}

type TextOpts = { size?: number; bold?: boolean; color?: RGB; gap?: number };

/** Tiny cursor-based layout engine over pdf-lib: wrapped text, key/value rows,
 *  paginated tables, and a repeating footer with page numbers. */
export class Pdf {
  private doc!: PDFDocument;
  private font!: PDFFont;
  private bold!: PDFFont;
  private page!: PDFPage;
  private y = 0;
  private title: string;

  private constructor(title: string) {
    this.title = title;
  }

  static async create(title: string): Promise<Pdf> {
    const p = new Pdf(title);
    p.doc = await PDFDocument.create();
    p.font = await p.doc.embedFont(StandardFonts.Helvetica);
    p.bold = await p.doc.embedFont(StandardFonts.HelveticaBold);
    p.addPage();
    return p;
  }

  private addPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  private ensure(h: number) {
    if (this.y - h < MARGIN + 24) this.addPage();
  }

  private wrap(text: string, size: number, font: PDFFont, width: number): string[] {
    const lines: string[] = [];
    for (const raw of sanitize(text).split("\n")) {
      const words = raw.split(/\s+/);
      let line = "";
      for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(test, size) > width && line) {
          lines.push(line);
          line = w;
        } else {
          line = test;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  /** Document title block with the FarmGear wordmark. */
  header(subtitle?: string) {
    this.page.drawText("FarmGear", { x: MARGIN, y: this.y, size: 12, font: this.bold, color: BRAND });
    this.y -= 24;
    this.page.drawText(sanitize(this.title), { x: MARGIN, y: this.y, size: 20, font: this.bold, color: INK });
    this.y -= 18;
    if (subtitle) {
      this.page.drawText(sanitize(subtitle), { x: MARGIN, y: this.y, size: 11, font: this.font, color: MUTED });
      this.y -= 16;
    }
    this.hr();
  }

  heading(text: string) {
    this.ensure(28);
    this.y -= 10;
    this.page.drawText(sanitize(text), { x: MARGIN, y: this.y, size: 13, font: this.bold, color: INK });
    this.y -= 16;
  }

  text(text: string, opts: TextOpts = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    for (const line of this.wrap(text, size, font, CONTENT_W)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font, color: opts.color ?? INK });
      this.y -= size + 4;
    }
    if (opts.gap) this.y -= opts.gap;
  }

  /** Label/value row (label muted, left; value right-aligned block under label width). */
  kv(label: string, value: string) {
    this.ensure(16);
    this.page.drawText(sanitize(label), { x: MARGIN, y: this.y, size: 9, font: this.font, color: MUTED });
    const val = this.wrap(value, 10, this.font, CONTENT_W - 160);
    this.page.drawText(val[0] ?? "", { x: MARGIN + 160, y: this.y, size: 10, font: this.font, color: INK });
    this.y -= 14;
    for (const extra of val.slice(1)) {
      this.ensure(14);
      this.page.drawText(extra, { x: MARGIN + 160, y: this.y, size: 10, font: this.font, color: INK });
      this.y -= 14;
    }
  }

  hr() {
    this.ensure(10);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.75, color: RULE });
    this.y -= 12;
  }

  gap(h = 8) { this.y -= h; }

  /** Paginated table. `align` marks right-aligned columns. */
  table(headers: string[], rows: string[][], widths: number[], align: boolean[] = []) {
    const size = 9;
    const rowH = 16;
    const drawRow = (cells: string[], font: PDFFont, color: RGB) => {
      let x = MARGIN;
      cells.forEach((c, i) => {
        const w = widths[i];
        const s = sanitize(c);
        const tw = font.widthOfTextAtSize(s, size);
        const tx = align[i] ? x + w - tw : x;
        this.page.drawText(s, { x: tx, y: this.y, size, font, color });
        x += w;
      });
    };
    this.ensure(rowH + 4);
    drawRow(headers, this.bold, MUTED);
    this.y -= 4;
    this.hr();
    for (const row of rows) {
      this.ensure(rowH);
      drawRow(row, this.font, INK);
      this.y -= rowH;
    }
  }

  private footers() {
    const pages = this.doc.getPages();
    const total = pages.length;
    const stamp = `FarmGear · generated ${new Date().toISOString().slice(0, 10)}`;
    pages.forEach((pg, i) => {
      pg.drawText(sanitize(stamp), { x: MARGIN, y: MARGIN - 16, size: 8, font: this.font, color: MUTED });
      const label = `${i + 1} / ${total}`;
      const w = this.font.widthOfTextAtSize(label, 8);
      pg.drawText(label, { x: PAGE_W - MARGIN - w, y: MARGIN - 16, size: 8, font: this.font, color: MUTED });
    });
  }

  async save(): Promise<Uint8Array> {
    this.footers();
    return this.doc.save();
  }
}

/** Build a PDF Response with an attachment filename. */
export function pdfResponse(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
