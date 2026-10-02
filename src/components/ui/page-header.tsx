import type { ReactNode } from "react";
import Link from "next/link";
import type { Lang } from "@/lib/i18n";
import { cn } from "./cn";
import { ChevronLeftIcon } from "./icons";
import { PageInfoButton } from "./page-info-button";

/* ==========================================================================
 * PageContainer: one width convention instead of seven
 * ==========================================================================
 *
 * Pages used to pick their own wrapper: full-bleed, max-w-2xl, 3xl, 4xl, 5xl, 6xl, md,
 * all centred with mx-auto. So the title jumped sideways as people moved through the
 * sidebar (/settings started its h1 at x=475 on a laptop, /machines at x=288), and
 * related screens disagreed (/suppliers 3xl, /documents full width).
 *
 * Three sizes, all LEFT-aligned. Left, not centred, because the title's position should
 * be the one thing that does not move between screens; a centred narrow column is what
 * made it wander. On a phone all three are simply full width.
 *
 *   narrow   max-w-2xl  settings, account, a form-like screen, a single short record
 *   default  max-w-4xl  a detail page, the books (money, VAT, expenses, banking), reading
 *   wide     no cap     lists, tables, boards, calendars, dashboards
 *
 * It also owns the vertical rhythm: every direct child is 24px (gap-6) from the next,
 * so `PageHeader` is the same distance from the content on every screen. Do not add a
 * margin under the header or wrap the page in another `space-y-*`.
 */
export type PageWidth = "narrow" | "default" | "wide";

const WIDTH: Record<PageWidth, string> = {
  narrow: "max-w-2xl",
  default: "max-w-4xl",
  wide: "",
};

export type PageContainerProps = {
  size?: PageWidth;
  className?: string;
  children: ReactNode;
};

export function PageContainer({ size = "default", className, children }: PageContainerProps) {
  // min-w-0 so a wide child (a table in its own overflow-x wrapper, a money figure joined
  // with U+00A0) can never widen the page past a 360px phone.
  return <div className={cn("flex w-full min-w-0 flex-col gap-6", WIDTH[size], className)}>{children}</div>;
}

/* ==========================================================================
 * BackLink
 * ========================================================================== */

export type BackTarget = {
  /** Usually the list root, or `backHref(sp.from, "/list")` to keep the list's filters. */
  href: string;
  /** Translated, e.g. the list it returns to. Name the place, not "Back". */
  label: string;
};

/**
 * Chevron plus the name of the place it returns to, at the 48px floor on phones. Detail
 * pages hand-rolled this three ways (a chevron in sand-500, plain underlined brand text,
 * no chevron), none of them tall enough for a thumb.
 */
export function BackLink({ href, label, className }: BackTarget & { className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "focus-ring -ml-2 inline-flex min-h-[48px] max-w-full items-center gap-1 self-start rounded-lg pl-1 pr-2 text-sm font-medium text-ink-muted hover:bg-sand-100 hover:text-ink sm:min-h-[40px]",
        className,
      )}
    >
      <ChevronLeftIcon className="shrink-0 text-lg" />
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  );
}

/* ==========================================================================
 * PageHeader
 * ========================================================================== */

type InfoProps =
  | {
      /** Stem of the page's `pageInfo.<key>Title/What/Does/Note` strings. */
      infoKey: string;
      locale: Lang;
    }
  | { infoKey?: undefined; locale?: Lang };

export type PageHeaderProps = InfoProps & {
  /** The page's name. Always the page's one h1. */
  title: ReactNode;
  /** One sentence under the title: what this screen is, or what to do here. */
  lead?: ReactNode;
  /** A short fact on the line under the title: a date, a count, a farm name. */
  meta?: ReactNode;
  /** A status badge for the thing this page is about (a StatusBadge, a Badge). */
  badge?: ReactNode;
  /**
   * The page's own actions. At most ONE filled primary (the thing this screen exists to
   * start), plus secondaries or an ActionMenu for the rest. Right-aligned from `sm`; on a
   * phone they take their own full-width row under the title.
   */
  actions?: ReactNode;
  /**
   * The overflow menu for the thing this page is about (an ActionMenu, "More"). It sits
   * on the title row at its natural size, on a phone too, instead of stretching into a
   * full-width button the way a primary action does: a detail page whose real actions
   * live in its own status panel needs the menu within reach, not a slab under the title.
   */
  menu?: ReactNode;
  /** A back link above the title, for a detail page. */
  back?: BackTarget;
  /** Set when something else needs to point at the h1 (aria-labelledby). */
  titleId?: string;
  className?: string;
};

/**
 * The top of every screen, built once so it looks and behaves the same everywhere.
 *
 * About 80 pages hand-built this with 25 wrapper variants and 12 lead styles. On a 360px
 * phone the "What is this?" button shared a row with the h1 and either wrapped the title
 * one word per line ("Accidents & claims"), crushed the lead into half the width, or
 * dropped onto a row of its own between the title and the date.
 *
 * The layout that fixes it:
 *   1. optional back link;
 *   2. the h1, alone on its row at full width, wrapping within itself;
 *   3. one quiet line under it: badge, meta, then "What is this?" (icon and word). It
 *      never takes width from the title, and it never lands between the title and the
 *      date, because the date is on the same line;
 *   4. the lead, one style;
 *   5. actions: on the right from `sm`, their own full-width row on a phone.
 *
 * Server component. Put it first inside `PageContainer`, which sets the space below it.
 *
 *   <PageContainer size="wide">
 *     <PageHeader
 *       title={t("machines.title", locale)}
 *       lead={t(LEAD_KEY, locale)}
 *       infoKey="machines"
 *       locale={locale}
 *       actions={<NewMachine ... />}
 *     />
 *     ...
 *   </PageContainer>
 */
export function PageHeader({
  title,
  lead,
  meta,
  badge,
  actions,
  menu,
  back,
  titleId,
  className,
  infoKey,
  locale,
}: PageHeaderProps) {
  // Negative margins keep the 48px hit area while the line itself stays text height, and
  // line the icon up with the title's left edge.
  const info =
    infoKey && locale ? (
      <PageInfoButton infoKey={infoKey} locale={locale} className="-mx-2 -my-3 sm:-my-2" />
    ) : null;
  const metaRow = badge || meta || info;

  return (
    <header className={cn("flex min-w-0 flex-col gap-3", className)}>
      {back ? <BackLink href={back.href} label={back.label} className="-mb-2 -mt-2" /> : null}

      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {menu ? (
            <div className="flex min-w-0 items-start justify-between gap-3">
              <h1 id={titleId} className="min-w-0 break-words text-2xl font-bold tracking-tight text-ink">
                {title}
              </h1>
              <div className="shrink-0">{menu}</div>
            </div>
          ) : (
            <h1 id={titleId} className="min-w-0 break-words text-2xl font-bold tracking-tight text-ink">
              {title}
            </h1>
          )}

          {metaRow ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
              {badge}
              {meta ? <span className="min-w-0 break-words">{meta}</span> : null}
              {info}
            </div>
          ) : null}

          {lead ? <p className="mt-1 max-w-prose text-sm text-ink-muted">{lead}</p> : null}
        </div>

        {actions ? (
          // Phone: a column, so each action stretches to the full width under the title.
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
