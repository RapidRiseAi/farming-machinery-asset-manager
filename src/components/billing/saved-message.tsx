import { Flash } from "@/components/ui/flash";
import { Toast } from "@/components/ui/toast";
import { t, type Lang } from "@/lib/i18n";
import { savedIsTransient, type SavedNotice } from "@/lib/billing/view";

/**
 * Long enough to read one sentence about money at an unhurried pace, these say what was
 * charged and when, not "Saved", and the reader can dismiss it sooner.
 */
const TOAST_MS = 10_000;

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
 * Server component. `Toast` is the client piece and receives only serialisable props.
 */
export function SavedMessage({ notice, locale }: { notice: SavedNotice | null; locale: Lang }) {
  if (!notice) return null;
  const message = t(notice.key, locale);
  if (!savedIsTransient(notice)) return <Flash tone={notice.tone} message={message} />;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 pb-safe lg:bottom-6 lg:left-64">
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
