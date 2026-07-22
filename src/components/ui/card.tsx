import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  /** Remove the default inner padding (e.g. for a Card that wraps a Table). */
  flush?: boolean;
};

/** A surface panel: white, warm border, soft shadow, friendly radius. */
export function Card({ flush = false, className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border border-sand-200 bg-white shadow-card",
        !flush && "p-4 sm:p-5",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type CardHeaderProps = HTMLAttributes<HTMLDivElement> & {
  /** Right-aligned actions (buttons, links). */
  action?: ReactNode;
};

/** Header row for a Card: title area on the left, optional `action` on the right. */
export function CardHeader({ action, className, children, ...props }: CardHeaderProps) {
  return (
    <div className={cn("mb-3 flex items-start justify-between gap-3", className)} {...props}>
      <div className="min-w-0">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export type CardTitleProps = HTMLAttributes<HTMLHeadingElement> & {
  as?: ElementType;
};

/** Card title. Defaults to an `<h2>`; override level with `as`. */
export function CardTitle({ as: Tag = "h2", className, children, ...props }: CardTitleProps) {
  return (
    <Tag className={cn("text-base font-semibold text-sand-900", className)} {...props}>
      {children}
    </Tag>
  );
}
