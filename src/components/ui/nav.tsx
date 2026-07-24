"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { Icon, MoreIcon, type IconName } from "./icons";
import { Sheet } from "./dialog";

export type NavItemData = {
  href: string;
  label: string;
  icon: IconName;
  /** Optional unread count → a small pill on the item (e.g. the inbox). */
  badge?: number;
};

/** Small unread-count pill shown on a nav item (caps at 99+). */
function Badge({ count, className }: { count: number; className?: string }) {
  if (!count || count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-[1.05rem] items-center justify-center rounded-full bg-brand-600 px-1 text-[0.62rem] font-bold leading-none text-white",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function useIsActive(href: string) {
  const pathname = usePathname();
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * Active-aware nav link (reads `usePathname`). `variant` switches between the
 * desktop sidebar row and the mobile bottom-tab layout.
 */
export function NavLink({
  item,
  variant,
}: {
  item: NavItemData;
  variant: "sidebar" | "tab";
}) {
  const active = useIsActive(item.href);

  if (variant === "tab") {
    return (
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "focus-ring relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[0.68rem] font-medium",
          active ? "text-brand-700" : "text-sand-500",
        )}
      >
        <span className="relative">
          <Icon name={item.icon} className="text-[1.4rem]" />
          {item.badge ? <Badge count={item.badge} className="absolute -right-2.5 -top-1.5" /> : null}
        </span>
        <span className="max-w-full truncate">{item.label}</span>
      </Link>
    );
  }

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-ring flex min-h-[44px] items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
        active
          ? "bg-brand-50 text-brand-700"
          : "text-sand-700 hover:bg-sand-100 hover:text-sand-900",
      )}
    >
      <Icon name={item.icon} className="text-[1.3rem]" />
      <span className="truncate">{item.label}</span>
      {item.badge ? <Badge count={item.badge} className="ml-auto" /> : null}
    </Link>
  );
}

/**
 * The 5th mobile bottom-tab: a "More" button that opens a bottom Sheet listing
 * the overflow nav items plus a sign-out slot. Highlights when the current
 * route is one of its items. The sign-out form is passed in from the server
 * layout so the server action stays server-side.
 */
export function MoreMenu({
  label,
  title,
  closeLabel,
  items,
  signOutSlot,
}: {
  label: string;
  title: string;
  closeLabel: string;
  items: NavItemData[];
  signOutSlot: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const active = items.some(
    (i) => pathname === i.href || pathname.startsWith(i.href + "/"),
  );
  // Surface overflow unread counts on the collapsed "More" button.
  const badgeTotal = items.reduce((a, i) => a + (i.badge ?? 0), 0);

  // Close the sheet after a navigation.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          "focus-ring relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[0.68rem] font-medium",
          active || open ? "text-brand-700" : "text-sand-500",
        )}
      >
        <span className="relative">
          <MoreIcon className="text-[1.4rem]" />
          {badgeTotal > 0 ? <Badge count={badgeTotal} className="absolute -right-2.5 -top-1.5" /> : null}
        </span>
        <span>{label}</span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={title} closeLabel={closeLabel}>
        <nav className="flex flex-col">
          {items.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "focus-ring flex min-h-[52px] items-center gap-3 rounded-lg px-3 text-[0.95rem] font-medium",
                  isActive
                    ? "bg-brand-50 text-brand-700"
                    : "text-sand-800 hover:bg-sand-100",
                )}
              >
                <Icon name={item.icon} className="text-[1.35rem] text-sand-500" />
                <span className="flex-1 truncate">{item.label}</span>
                {item.badge ? <Badge count={item.badge} /> : null}
              </Link>
            );
          })}
          <div className="my-1 h-px bg-sand-100" />
          {signOutSlot}
        </nav>
      </Sheet>
    </>
  );
}
