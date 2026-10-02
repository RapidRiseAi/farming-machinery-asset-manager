"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";
import { DialogForm, useDialogForm } from "@/components/ui/dialog-form";
import type { ButtonVariant } from "@/components/ui/button";
import { FaultCapture } from "@/components/fault-capture";

type Machine = { id: string; name: string };

type CaptureProps = {
  machines: Machine[];
  defaultMachineId?: string;
  redirectTo: string;
  locale: Lang;
};

/** Lives inside the dialog, so it can hand FaultCapture the dialog's own close. */
function CaptureInDialog(props: CaptureProps) {
  const { close } = useDialogForm();
  return <FaultCapture endpoint="/api/faults" variant="app" onDone={close} {...props} />;
}

/**
 * "Report a fault" as a dialog: the trigger, the dialog and the capture form.
 *
 * Use it instead of wiring `DialogForm` + `FaultCapture` by hand: inside it the form
 * confirms in place after sending ("Problem sent", naming the machine, with Done)
 * instead of reloading onto a generic "Saved.".
 *
 * `openParam` (e.g. "report") opens the dialog when the URL carries `?report=1`, which
 * is what the tab bar's "Report a fault" links to, and then removes the parameter
 * from the address bar so a refresh does not reopen it and the next tap works again.
 * Only one dialog on a page should take `openParam`.
 */
export function ReportFaultDialog({
  machines,
  defaultMachineId,
  redirectTo,
  locale,
  openParam,
  trigger,
  title,
  description,
  triggerVariant = "primary",
  triggerFullWidth,
  triggerIcon,
  triggerClassName,
}: CaptureProps & {
  openParam?: string;
  trigger?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  triggerVariant?: ButtonVariant;
  triggerFullWidth?: boolean;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
}) {
  const params = useSearchParams();
  const asked = openParam ? params.get(openParam) === "1" : false;
  // Remounting with `defaultOpen` is how a link opens it: DialogForm reads that once.
  const [opened, setOpened] = useState(0);

  useEffect(() => {
    if (!asked || !openParam) return;
    setOpened((n) => n + 1);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete(openParam);
      url.searchParams.delete("machine");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* leaving the parameter in place only means a refresh opens it again */
    }
  }, [asked, openParam]);

  return (
    <DialogForm
      key={opened}
      defaultOpen={opened > 0}
      trigger={trigger ?? t("faults.report", locale)}
      triggerVariant={triggerVariant}
      triggerFullWidth={triggerFullWidth}
      triggerIcon={triggerIcon}
      triggerClassName={triggerClassName}
      title={title ?? t("faults.report", locale)}
      description={description}
      closeLabel={t("ui.close", locale)}
      size="md"
    >
      <CaptureInDialog machines={machines} defaultMachineId={defaultMachineId} redirectTo={redirectTo} locale={locale} />
    </DialogForm>
  );
}
