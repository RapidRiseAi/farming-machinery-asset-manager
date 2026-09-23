import { cn } from "./cn";

/**
 * The look of one row in an `ActionMenu`.
 *
 * == Why it is its own module =================================================
 * Four components render a menu row and none of them can do it with a `className`:
 * `ActionMenu` itself, and the three things that appear INSIDE one, which are
 * `DialogForm` (open a form over this row), `ConfirmDialog` (delete this row) and
 * `SubmitButton` (post a one-field lifecycle action for this row). Each of those
 * otherwise renders through `buttonVariants`, which already supplies `justify-center`
 * and its own padding; `cn` does not de-duplicate conflicting Tailwind utilities, so
 * passing row padding as a `className` leaves both in the class list and the result is
 * a centred, doubly padded button.
 *
 * It lives here rather than in `action-menu.tsx` so that `SubmitButton` does not have
 * to import `ActionMenu`, and with it `Overlay`, `createPortal` and a focus trap, into
 * the module graph of every form in the product that has nothing to do with menus.
 *
 * == NEVER re-export this from a "use client" module ==========================
 * `action-menu.tsx` briefly carried `export { menuItemClass }` as a convenience, and a
 * plain function re-exported from a client module is not a function any more: it is a
 * CLIENT REFERENCE. A Server Component may render it as a component or pass it as a
 * prop, and calling it throws
 *
 *   Attempted to call menuItemClass() from the server but menuItemClass is on the
 *   client. It's not possible to invoke a client function from the server.
 *
 * which took down the whole of `/machines/[id]` to its error boundary. `tsc` cannot see
 * it, because the types are identical and correct; `next build` cannot see it, because
 * it compiles; the error exists only at render.
 *
 * Worse, it hides. `/incidents` had the same bad import and PASSED every gate, because
 * its one `menuItemClass()` call sits behind `r.job_card_id` and the test farm's
 * incident has no job card. It would have crashed for the first customer who linked a
 * repair to an accident. Server Components import it from here, directly, and this
 * module has no "use client" for exactly that reason.
 */
export function menuItemClass(
  tone: "default" | "danger" = "default",
  className?: string,
): string {
  return cn(
    "focus-ring inline-flex min-h-[48px] w-full items-center justify-start gap-2.5 rounded-lg",
    "border px-3.5 text-left text-sm font-medium transition-colors",
    // `callout-danger-ink` and not `danger-600`: the callout triple is the one pair
    // verified to clear 4.5:1 on its own tint in BOTH themes, and this row is tinted
    // on hover. A fixed shade from the scale fails that in dark mode.
    tone === "danger"
      ? "border-callout-danger-edge text-callout-danger-ink hover:bg-callout-danger-bg"
      : "border-sand-200 text-sand-800 hover:bg-sand-50",
    className,
  );
}
