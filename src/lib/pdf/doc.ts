import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";

// A4 in points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - 2 * MARGIN;

const INK = rgb(0.15, 0.13, 0.11);
const MUTED = rgb(0.42, 0.39, 0.34);
const RULE = rgb(0.9, 0.88, 0.84);
const BRAND = rgb(0.08, 0.5, 0.24);

/** Space kept clear at the right of a table cell, so two columns never touch. */
const TABLE_GUTTER = 5;

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

/**
 * Whose document this is (F14a).
 *
 * A partner's quote or invoice must leave here on THEIR letterhead — their name, their
 * colour, their logo, their footer — not ours. Passing no brand keeps the FleetWise
 * wordmark and green, which is what the job-card and machine-file PDFs still want.
 */
export type PdfBrand = {
  /** Wordmark text — the partner's trading name, or "FleetWise". */
  name: string;
  /** Header colour as `#RRGGBB`. */
  primary?: string | null;
  /** PNG or JPEG bytes for a logo; anything else is skipped rather than crashing. */
  logo?: { bytes: Uint8Array; contentType: string } | null;
  /** Replaces the generated-on footer stamp when set. */
  footer?: string | null;
  /** Append the FleetWise credit to the footer. */
  poweredBy?: boolean;
  /**
   * How the partner's colour appears (0434 `accent_style`, chosen through a 0505 template).
   *
   * `band` is the DEFAULT and is exactly what this engine has always drawn — the wordmark
   * set in the brand colour. It is deliberately not changed to paint a filled rectangle:
   * every existing partner is on `band`, so that would restyle documents nobody asked to
   * restyle. `line` adds a rule in the brand colour above the wordmark; `plain` removes
   * every trace of colour from the page, which is the point of it — a solid band comes out
   * of a mono photocopier as a grey smear.
   */
  accent?: "band" | "line" | "plain";
  /**
   * Extra points of vertical space in a table row, a key/value row and around a heading
   * (0434 `density`, via `pdfRowGap`). 8 is the default and reproduces today's spacing to
   * the point; 4 is `compact`. One knob rather than three so the whole document tightens
   * together instead of the table drifting away from the totals beside it.
   */
  rowGap?: number;
};

function hexRgb(hex: string | null | undefined, fallback: RGB): RGB {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  return rgb(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  );
}

/** Tiny cursor-based layout engine over pdf-lib: wrapped text, key/value rows,
 *  paginated tables, and a repeating footer with page numbers. */
export class Pdf {
  private doc!: PDFDocument;
  private font!: PDFFont;
  private bold!: PDFFont;
  private page!: PDFPage;
  private y = 0;
  private title: string;
  private brand: PdfBrand;
  private accent: RGB;
  private logo: PDFImage | null = null;
  /** See `PdfBrand.rowGap`. 8 = today's spacing; clamped so a bad value cannot break a page. */
  private rowGap: number;
  private accentStyle: "band" | "line" | "plain";

  private constructor(title: string, brand: PdfBrand) {
    this.title = title;
    this.brand = brand;
    this.accent = hexRgb(brand.primary, BRAND);
    this.rowGap = Math.min(12, Math.max(2, Math.round(brand.rowGap ?? 8)));
    this.accentStyle = brand.accent ?? "band";
  }

  static async create(title: string, brand?: PdfBrand): Promise<Pdf> {
    const p = new Pdf(title, brand ?? { name: "FleetWise", poweredBy: false });
    p.doc = await PDFDocument.create();
    p.font = await p.doc.embedFont(StandardFonts.Helvetica);
    p.bold = await p.doc.embedFont(StandardFonts.HelveticaBold);
    if (p.brand.logo) {
      try {
        p.logo = /png/i.test(p.brand.logo.contentType)
          ? await p.doc.embedPng(p.brand.logo.bytes)
          : await p.doc.embedJpg(p.brand.logo.bytes);
      } catch {
        // A logo that pdf-lib will not embed must never stop a partner sending an
        // invoice — fall back to the wordmark alone.
        p.logo = null;
      }
    }
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

  /** Document title block with the issuer's wordmark (and logo, when they have one). */
  header(subtitle?: string) {
    // `plain` means no colour on the page at all — including the wordmark, which is the
    // only coloured thing this engine draws.
    const wordmark = this.accentStyle === "plain" ? INK : this.accent;
    if (this.accentStyle === "line") {
      this.page.drawLine({
        start: { x: MARGIN, y: this.y + 6 },
        end: { x: PAGE_W - MARGIN, y: this.y + 6 },
        thickness: 3,
        color: this.accent,
      });
      this.y -= 8;
    }
    if (this.logo) {
      const h = 28;
      const w = Math.min(90, (this.logo.width / this.logo.height) * h);
      this.page.drawImage(this.logo, { x: MARGIN, y: this.y - h + 10, width: w, height: h });
      this.page.drawText(sanitize(this.brand.name), {
        x: MARGIN + w + 10, y: this.y, size: 12, font: this.bold, color: wordmark,
      });
      this.y -= 34;
    } else {
      this.page.drawText(sanitize(this.brand.name), { x: MARGIN, y: this.y, size: 12, font: this.bold, color: wordmark });
      this.y -= 24;
    }
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
    this.y -= 2 + this.rowGap;
    this.page.drawText(sanitize(text), { x: MARGIN, y: this.y, size: 13, font: this.bold, color: INK });
    this.y -= 8 + this.rowGap;
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
    const step = 6 + this.rowGap;
    this.ensure(16);
    this.page.drawText(sanitize(label), { x: MARGIN, y: this.y, size: 9, font: this.font, color: MUTED });
    const val = this.wrap(value, 10, this.font, CONTENT_W - 160);
    this.page.drawText(val[0] ?? "", { x: MARGIN + 160, y: this.y, size: 10, font: this.font, color: INK });
    this.y -= step;
    for (const extra of val.slice(1)) {
      this.ensure(step);
      this.page.drawText(extra, { x: MARGIN + 160, y: this.y, size: 10, font: this.font, color: INK });
      this.y -= step;
    }
  }

  hr() {
    this.ensure(10);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.75, color: RULE });
    this.y -= 12;
  }

  gap(h = 8) { this.y -= h; }

  /**
   * Trim `s` to fit `width`, ending in an ellipsis when it will not go.
   *
   * `table()` used to draw a cell at its column's x and then step x by the column width,
   * with nothing in between measuring anything. A description wider than its column
   * therefore ran straight over the neighbour — and because the neighbour is usually a
   * money column, an ordinary parts line like "Front wheel bearing kit + oil seal set"
   * (143pt in a 130pt column) printed on top of a rand amount. Silently: no warning, no
   * clipping, just two strings sharing the same ink.
   *
   * A gutter is subtracted as well as the overflow, because columns that merely touch are
   * still unreadable. The ellipsis is U+2026, which `sanitize` already passes through to
   * WinAnsi, so it survives the same encoder as the rest of the row.
   */
  private fit(s: string, width: number, font: PDFFont, size: number): string {
    const max = width - TABLE_GUTTER;
    if (max <= 0 || font.widthOfTextAtSize(s, size) <= max) return s;
    const ell = "…";
    const ellW = font.widthOfTextAtSize(ell, size);
    // A column too narrow even for the ellipsis: draw nothing rather than one stray dot
    // sitting in a neighbour's cell.
    if (ellW > max) return "";
    let out = s;
    while (out.length > 0 && font.widthOfTextAtSize(out, size) + ellW > max) out = out.slice(0, -1);
    return out.replace(/\s+$/, "") + ell;
  }

  /** Paginated table. `align` marks right-aligned columns. */
  table(headers: string[], rows: string[][], widths: number[], align: boolean[] = []) {
    const size = 9;
    const rowH = 8 + this.rowGap;
    const drawRow = (cells: string[], font: PDFFont, color: RGB) => {
      let x = MARGIN;
      cells.forEach((c, i) => {
        const w = widths[i];
        // Right-aligned columns are money and quantities, and money is never abbreviated:
        // "R12 4…" is worse than an overlap, because an overlap is visibly wrong while a
        // truncated amount reads as a smaller number. A right-aligned cell that does not
        // fit is a column-width bug, and it stays visible so somebody fixes it.
        const s = align[i] ? sanitize(c) : this.fit(sanitize(c), w, font, size);
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
    const credit = this.brand.poweredBy ? " · powered by FleetWise" : "";
    const stamp = this.brand.footer
      ? `${this.brand.footer}${credit}`
      : `${this.brand.name} · generated ${new Date().toISOString().slice(0, 10)}${credit}`;
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
