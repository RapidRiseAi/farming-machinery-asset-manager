import { Flash, KeepResultParams } from "@/components/ui/flash";
import { Toast } from "@/components/ui/toast";
import { ClearResultParams } from "@/components/ui/clear-result-params";
import { t, type Lang } from "@/lib/i18n";
import { savedIsTransient, type SavedNotice } from "@/lib/billing/view";

/**
 * Long enough to read one sentence about money at an unhurried pace, these say what was
 * charged and when, not "Saved", and the reader can dismiss it sooner.
 */
const TOAST_MS = 10_000;

/** The one result key billing reports through; see the note on `SavedMessage`. */
const SAVED_ONLY: readonly string[] = ["saved"];

/**
 * What a billing action just did, said once and in the right place.
 *
 * Shared by `/billing` and `/admin/billing`, so the two screens present an outcome the same
 * way as well as in the same words (`savedNotice`).
 *
 * A confirmation is a `Toast`, fixed just above the phone's tab bar, so it overlays the
 * page instead of pushing everything down on every action, and it clears itself. Anything
 * that must stay, `savedIsTransient` is false, which includes the "we are checking that
 * payment, do not pay again" message, is the ordinary inline `Flash`, exactly as before.
 *
 * The toast also takes `?saved=` out of the address bar once it is showing, so a refresh or
 * a Back does not announce the charge a second time. ONLY `saved`: `/billing` keeps its
 * `panel`, `change` and `checkout` steps in the URL. The sticky kind keeps its parameter
 * on purpose: "we are checking that payment, do not pay again" must survive a refresh,
 * which is exactly when someone is tempted to pay again. `KeepResultParams` guards it
 * from the page's OTHER Flashes too (the card-expiry warning renders on every visit and
 * would otherwise clear `saved` as soon as the page loaded).
 *
 * Server component. `Toast` is the client piece and receives only serialisable props.
 */
export function SavedMessage({ notice, locale }: { notice: SavedNotice | null; locale: Lang }) {
  if (!notice) return null;
  const message = t(notice.key, locale);
  if (!savedIsTransient(notice)) {
    return (
      <>
        <KeepResultParams keys={SAVED_ONLY} />
        <Flash tone={notice.tone} message={message} clearParams={false} />
      </>
    );
  }
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 pb-safe lg:bottom-6 lg:left-64">
      <ClearResultParams keys={SAVED_ONLY} />
      <Toast
        // A different outcome is a different toast, not the old one's dismissed state.
        key={notice.key}
        tone={notice.tone}
        message={message}
        duration={TOAST_MS}
        closeLabel={t("ui.dismiss", locale)}
        className="pointer-events-auto w-full max-w-md"
      />
    </div>
  );
}
