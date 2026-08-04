import { t, type Lang } from "@/lib/i18n";
import { PageInfo } from "./page-info";

/**
 * Server-side wrapper that turns an i18n key stem into the page's "What is this?"
 * button, so a page adds one line rather than assembling four strings itself.
 *
 * Bullet lines live as ONE newline-separated string in the dictionaries: the `t()`
 * helper only returns strings, and keeping them in a single key means the EN/AF parity
 * check still covers them — an array or a numbered set would let one language quietly
 * carry a different number of points.
 */
export function PageInfoButton({ infoKey, locale }: { infoKey: string; locale: Lang }) {
  const note = t(`pageInfo.${infoKey}Note`, locale);
  return (
    <PageInfo
      content={{
        title: t(`pageInfo.${infoKey}Title`, locale),
        what: t(`pageInfo.${infoKey}What`, locale),
        does: t(`pageInfo.${infoKey}Does`, locale).split("\n").filter(Boolean),
        // `t()` falls back to the key itself; an optional note that was never written
        // must not render as "pageInfo.fooNote".
        note: note.startsWith("pageInfo.") ? undefined : note,
      }}
      buttonLabel={t("pageInfo.button", locale)}
      closeLabel={t("pageInfo.close", locale)}
      tourLabel={t("tour.restart", locale)}
      headingId={`info-${infoKey}`}
    />
  );
}
