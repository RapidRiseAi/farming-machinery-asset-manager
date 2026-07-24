"use client";

import { useState } from "react";
import { CopyIcon, CheckIcon } from "@/components/ui/icons";

/**
 * Read-only value (a generated login URL) with a copy-to-clipboard button. Client
 * component — clipboard access needs the browser. Falls back to selecting the text
 * if the Clipboard API is unavailable.
 */
export function CopyField({
  value,
  copyLabel,
  copiedLabel,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore — the value stays visible/selectable for a manual copy.
    }
  }

  return (
    <div className="flex items-stretch gap-2">
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 rounded-lg border border-sand-300 bg-sand-50 px-3 py-2 font-mono text-xs text-sand-700"
      />
      <button
        type="button"
        onClick={copy}
        className="focus-ring inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg border border-sand-300 bg-white px-3 text-sm font-medium text-sand-800 hover:bg-sand-50"
      >
        {copied ? <CheckIcon className="text-[1.1rem] text-status-ok" /> : <CopyIcon className="text-[1.1rem]" />}
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
