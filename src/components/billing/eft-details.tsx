import { cn } from "@/components/ui/cn";

/**
 * Rapid Rise's banking details beside a bill owed to Rapid Rise, with the invoice number to
 * use as the reference. The caller words the reference: what happens after the money lands
 * differs between a new farm, a paused one and one that is simply paying.
 */
export function EftDetails({
  details,
  title,
  reference,
  className,
}: {
  details: string;
  title: string;
  reference: string;
  className?: string;
}) {
  return (
    <div className={cn("border-t border-sand-300 pt-4 text-sm", className)}>
      <p className="font-semibold text-sand-900">{title}</p>
      <p className="mt-1 whitespace-pre-line text-sand-700">{details}</p>
      <p className="mt-2 text-sand-700">{reference}</p>
    </div>
  );
}
