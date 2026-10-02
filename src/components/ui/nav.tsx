"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { Icon, MoreIcon, type IconName } from "./icons";
import { Sheet } from "./dialog";
import { INSTALL_HREF, useStandalone } from "./use-standalone";

export type NavItemData = {
  href: string;
  label: string;
  icon: IconName;
  /** Optional "needs you" count → a small pill on the item (e.g. the inbox). */
  badge?: number;
  /**
   * Other nav hrefs that live UNDER this one (computed on the server from the role's own
   * catalogue). On one of those, this item is not active: /documents must not light up
   * beside "Corrections" on /documents/corrections, nor /contractor beside "My clients".
   * Real detail pages (/machines/[id]) are not nav items, so they keep prefix matching.
   */
  excludes?: string[];
};

const under = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(href + "/");

/** The most specific nav item wins: active on its own subtree, minus its nav children. */
function isNavItemActive(pathname: string, item: Pick<NavItemData, "href" | "excludes">): boolean {
  if (!under(pathname, item.href)) return false;
  return !(item.excludes ?? []).some((x) => under(pathname, x));
}

/**
 * Small count pill shown on a nav item. Caps at 99+ in the sidebar and at 9+ on the
 * phone tab bar, where a three-digit number would not fit over a 20px icon.
 */
function Badge({ count, className, cap = 99 }: { count: number; className?: string; cap?: number }) {
  if (!count || count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-[1.05rem] items-center justify-center rounded-full bg-brand-600 px-1 text-2xs font-bold leading-none text-white",
        className,
      )}
    >
      {count > cap ? `${cap}+` : count}
    </span>
  );
}

function useIsActive(item: NavItemData) {
  const pathname = usePathname();
  return isNavItemActive(pathname, item);
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
  const active = useIsActive(item);
  // Nobody needs "Install app" inside the installed app.
  const standalone = useStandalone();
  if (standalone && item.href === INSTALL_HREF) return null;

  if (variant === "tab") {
    return (
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          // `min-w-0`: a flex item's automatic minimum is its content, so without it a
          // long label refuses to truncate and widens the whole bar past the viewport.
          "focus-ring relative flex min-h-[56px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 py-1 text-2xs font-medium",
          active ? "text-brand-ink" : "text-ink-muted",
        )}
      >
        <span className="relative">
          <Icon name={item.icon} className="text-xl" />
          {item.badge ? <Badge count={item.badge} cap={9} className="absolute -right-2.5 -top-1.5" /> : null}
        </span>
        <span className="w-full truncate text-center tracking-tight">{item.label}</span>
      </Link>
    );
  }

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-ring flex min-h-[48px] items-center gap-3 rounded-lg px-3 sm:min-h-[44px] text-sm font-medium transition-colors",
        active
          ? "bg-brand-tint text-brand-ink"
          : "text-ink-muted hover:bg-surface-sunken hover:text-ink",
      )}
    >
      <Icon name={item.icon} className="text-xl" />
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
export type NavGroup = { key: string; label: string; items: NavItemData[] };

export function MoreMenu({
  label,
  title,
  closeLabel,
  groups,
  signOutSlot,
  newLabel,
}: {
  label: string;
  title: string;
  closeLabel: string;
  /**
   * The same grouped shape the desktop sidebar renders. It used to take a flat
   * `items` array, which is how a books-tier partner ended up with 21
   * undifferentiated rows on a phone while their sidebar had three named
   * sections, the two shells describing the product differently.
   */
  groups: NavGroup[];
  signOutSlot: ReactNode;
  /** Screen-reader text for the dot on the collapsed button ("Something new inside"). */
  newLabel?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const standalone = useStandalone();
  const shown = standalone
    ? groups
        .map((g) => ({ ...g, items: g.items.filter((i) => i.href !== INSTALL_HREF) }))
        .filter((g) => g.items.length > 0)
    : groups;
  const items = shown.flatMap((g) => g.items);
  const active = items.some((i) => isNavItemActive(pathname, i));
  // A dot, not a sum. Adding every overflow count together produced a permanent "77" on
  // every screen, a number that never goes down and so teaches people to ignore badges.
  // The counts themselves are inside, on the rows they belong to.
  const hasNew = items.some((i) => (i.badge ?? 0) > 0);

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
          "focus-ring relative flex min-h-[56px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 py-1 text-2xs font-medium",
          active || open ? "text-brand-ink" : "text-sand-500",
        )}
      >
        <span className="relative">
          <MoreIcon className="text-xl" />
          {hasNew ? (
            <span className="absolute -right-1 -top-0.5 h-2.5 w-2.5 rounded-full bg-brand-600 ring-2 ring-surface">
              {newLabel ? <span className="sr-only">{newLabel}</span> : null}
            </span>
          ) : null}
        </span>
        <span className="w-full truncate text-center tracking-tight">{label}</span>
      </button>

      {/*
        `rememberKey`: the sheet mounts fresh on every open, so a person who scrolled
        past nine books screens to reach "Settings" was put back at the top the next
        time they opened it. Measured before the fix: scrollTop 943 -> 0, every open.
      */}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        closeLabel={closeLabel}
        rememberKey="nav-more"
      >
        <nav className="flex flex-col gap-5">
          {shown.map((group) => (
            <div key={group.key} className="flex flex-col">
              <p className="sticky top-0 z-10 -mx-4 bg-surface px-7 pb-2 pt-2.5 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                {group.label}
              </p>
              {group.items.map((item) => {
                const isActive = isNavItemActive(pathname, item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "focus-ring flex min-h-[52px] items-center gap-3 rounded-lg px-3 text-base font-medium",
                      // The selected state is the brand accent (gold) plus a
                      // weight change and aria-current, never colour alone.
                      isActive
                        ? "bg-accent-tint font-semibold text-ink ring-1 ring-accent-rim"
                        : "text-ink hover:bg-surface-sunken",
                    )}
                  >
                    <Icon
                      name={item.icon}
                      className={cn("text-xl", isActive ? "text-accent-ink" : "text-ink-muted")}
                    />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge ? <Badge count={item.badge} /> : null}
                  </Link>
                );
              })}
            </div>
          ))}
          <div className="h-px bg-edge-soft" />
          {signOutSlot}
        </nav>
      </Sheet>
    </>
  );
}
