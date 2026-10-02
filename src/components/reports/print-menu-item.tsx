"use client";

import { menuItemClass } from "@/components/ui/menu-item";
import { DocumentsIcon } from "@/components/ui/icons";

/**
 * "Print" as a row in an `ActionMenu` (the reports Export menu).
 *
 * `ActionMenu` deliberately does not close on click, and printing with the sheet still
 * open puts the sheet on paper. So this first sends the menu an Escape, which its
 * `Overlay` already handles (the keydown bubbles through the portal to React's
 * handler), and prints once the sheet is gone.
 */
export function PrintMenuItem({ label }: { label: string }) {
  return (
    <button
      type="button"
      className={menuItemClass()}
      onClick={(e) => {
        e.currentTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        window.setTimeout(() => window.print(), 200);
      }}
    >
      <DocumentsIcon className="shrink-0 text-base text-sand-500" />
      {label}
    </button>
  );
}
