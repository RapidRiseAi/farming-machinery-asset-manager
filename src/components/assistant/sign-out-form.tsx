"use client";

import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { clearAllOfflineVoiceData } from "./offline-voice";
import { t, type Lang } from "@/lib/i18n";

/** Clears device-only voice blobs before allowing the server sign-out action to run. */
export function AssistantSafeSignOutForm({
  action,
  children,
  className,
  locale,
}: {
  action: NonNullable<ComponentProps<"form">["action"]>;
  children: ReactNode;
  className?: string;
  locale: Lang;
}) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearingRef = useRef(false);

  return (
    <form
      action={action}
      className={className}
      onSubmit={(event) => {
        if (clearingRef.current) return;
        event.preventDefault();
        const form = event.currentTarget;
        clearingRef.current = true;
        setClearing(true);
        setError(null);
        void clearAllOfflineVoiceData()
          .then(() => form.requestSubmit())
          .catch(() => {
            clearingRef.current = false;
            setClearing(false);
            setError(t("assistant.signOutClearFailed", locale));
          });
      }}
    >
      <fieldset disabled={clearing} className="contents">
        {children}
      </fieldset>
      {error ? <p role="alert" className="mt-2 px-3 text-xs font-medium text-red-700">{error}</p> : null}
    </form>
  );
}
