/**
 * Who the workshop buys from (G18, migrations 0480–0482).
 *
 * The shared model behind the supplier book, the capture form's picker and the payables
 * ageing, so the three cannot mean different things by "this supplier". Money is integer
 * cents throughout, and every figure derived here is derived the way `app.partner_creditors`
 * derives it — see `supplierPositions` for why that matters more than it looks.
 */

export type Supplier = {
  id: string;
  workshop_id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  vat_number: string | null;
  /** The workshop's account number WITH them — what is quoted on the phone. */
  account_number: string | null;
  /** Null means no term was agreed (cash on collection), not "zero days". */
  payment_terms_days: number | null;
  notes: string | null;
  active: boolean;
};

/** Just enough to render a picker. */
export type SupplierOption = Pick<Supplier, "id" | "name">;

/**
 * The key two spellings of one business share.
 *
 * This mirrors `lower(btrim(name))` — the expression behind the `suppliers_name_uq` index,
 * the 0481 resolution trigger and the 0482 ageing's fallback grouping. It exists so the
 * browser can warn about a duplicate before the database refuses one; the database stays
 * the authority, because a check in a form loses every race.
 */
export function supplierKey(name: string): string {
  return name.trim().toLowerCase();
}

/** What the workshop's relationship with one supplier currently amounts to. */
export type SupplierPosition = {
  invoices: number;
  spent_cents: number;
  unpaid: number;
  owed_cents: number;
};

export const EMPTY_POSITION: SupplierPosition = { invoices: 0, spent_cents: 0, unpaid: 0, owed_cents: 0 };

/**
 * Roll expenses up per supplier record.
 *
 * `owed_cents` is amount + VAT on rows with no `paid_on` — deliberately the same arithmetic
 * as `app.partner_creditors`, because what actually leaves the bank is the inclusive figure
 * and a supplier page that disagreed with /money about what is owed would make both screens
 * useless. Expenses with no `supplier_id` are skipped: they are not attached to any record
 * yet, and the ageing shows them under their own name.
 */
export function supplierPositions(
  expenses: readonly { supplier_id: string | null; amount_cents: number; vat_cents: number; paid_on: string | null }[]
): Map<string, SupplierPosition> {
  const out = new Map<string, SupplierPosition>();
  for (const e of expenses) {
    if (!e.supplier_id) continue;
    const p = out.get(e.supplier_id) ?? { ...EMPTY_POSITION };
    const total = e.amount_cents + e.vat_cents;
    p.invoices += 1;
    p.spent_cents += total;
    if (!e.paid_on) {
      p.unpaid += 1;
      p.owed_cents += total;
    }
    out.set(e.supplier_id, p);
  }
  return out;
}

/**
 * Postgres unique-violation. Surfaced as its own error code so the screen can say "you
 * already have a supplier by that name" rather than showing the constraint name — the
 * duplicate is the one failure a person will actually hit here, because filing a supplier
 * twice is exactly the habit this feature is replacing.
 */
export function isDuplicateName(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}
