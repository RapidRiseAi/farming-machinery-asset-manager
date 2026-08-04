"use client";

export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button
      onClick={() => window.print()}
      className="focus-ring inline-flex min-h-[48px] items-center gap-1.5 rounded-lg border border-sand-300 bg-white px-4 text-sm font-medium text-sand-700 hover:bg-sand-50 sm:min-h-[40px] print:hidden"
    >
      {label}
    </button>
  );
}
