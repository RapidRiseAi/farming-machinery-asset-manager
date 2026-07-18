"use client";

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-lg border border-gray-300 px-4 py-2 text-sm print:hidden"
    >
      Print
    </button>
  );
}
