"use client";

import { useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { CopyIcon, CheckIcon } from "@/components/ui/icons";

/** Copies text that is too long to show in a field, such as the message to send. */
export function CopyButton({
  value,
  label,
  copiedLabel,
}: {
  value: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore: the link and the code are still on screen to copy by hand.
    }
  }

  return (
    <button type="button" onClick={copy} className={buttonVariants({ variant: "primary", size: "sm" })}>
      {copied ? <CheckIcon className="text-base" /> : <CopyIcon className="text-base" />}
      {copied ? copiedLabel : label}
    </button>
  );
}

/**
 * Read-only value (an access link or its code) with a copy-to-clipboard button. Client
 * component, clipboard access needs the browser. Falls back to selecting the text
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
      // Ignore, the value stays visible/selectable for a manual copy.
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
        className="focus-ring inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg border border-sand-300 bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-50"
      >
        {copied ? <CheckIcon className="text-lg text-status-ok" /> : <CopyIcon className="text-lg" />}
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
