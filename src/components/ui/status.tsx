import { t, type Locale, type Lang } from "@/lib/i18n";
import { enumLabel } from "@/lib/format";
import {
  StatusBadge,
  look,
  SERVICE_LOOK,
  MACHINE_LOOK,
  JOB_LOOK,
  FAULT_LOOK,
  URGENCY_LOOK,
  WORK_LOOK,
  PRIORITY_LOOK,
  EXPIRY_LOOK,
  BUDGET_LOOK,
  FINE_LOOK,
  type StatusLook,
} from "./badge";

/**
 * One badge per domain enum, so a status looks the same everywhere it appears and no
 * screen has to re-derive a tone. Each pairs the shared shape+colour map with the
 * enum's own i18n group — the raw value never reaches the screen.
 *
 * Before this, `machines` rendered all six machine statuses as `tone="neutral"` (a
 * broken machine and a working one were identical rows), and the job-card list mapped
 * six statuses onto three tones.
 */
type Props = {
  value: string | null | undefined;
  locale: Lang;
  size?: "sm" | "md";
  className?: string;
};

function make(map: Record<string, StatusLook>, group: string) {
  return function Status({ value, locale, size = "sm", className }: Props) {
    if (!value) return null;
    const l = look(map, value);
    return (
      <StatusBadge
        label={enumLabel(group, value, locale)}
        tone={l.tone}
        shape={l.shape}
        size={size}
        className={className}
      />
    );
  };
}

/** Machine status — active / standby / in workshop / out of service / retired / sold. */
export const MachineStatus = make(MACHINE_LOOK, "machineStatus");

/** Job-card lifecycle. */
export const JobStatus = make(JOB_LOOK, "jobStatus");

/** Fault lifecycle. */
export const FaultStatus = make(FAULT_LOOK, "faultStatus");

/** How badly the machine is hurt, in the driver's words. */
export const UrgencyStatus = make(URGENCY_LOOK, "urgency");

/** Work-request lifecycle (all eight states). */
export const WorkStatus = make(WORK_LOOK, "workStatus");

/** Work-request priority. */
export const PriorityStatus = make(PRIORITY_LOOK, "workPriority");

/** Traffic-fine (AARTO) lifecycle. */
export const FineStatus = make(FINE_LOOK, "fineStatus");

/** Service due state — the traffic light the product turns on. */
export function ServiceStatus({ value, locale, size = "sm", className }: Props) {
  if (!value) return null;
  const l = look(SERVICE_LOOK, value);
  const label =
    value === "overdue"
      ? t("ui.statusOverdue", locale)
      : value === "due_soon"
        ? t("ui.statusDueSoon", locale)
        : t("ui.statusOk", locale);
  return <StatusBadge label={label} tone={l.tone} shape={l.shape} size={size} className={className} />;
}

/** Paper about to run out — licence, roadworthy, warranty. */
export function ExpiryStatus({ value, locale, size = "sm", className }: Props) {
  if (!value) return null;
  const l = look(EXPIRY_LOOK, value);
  return (
    <StatusBadge
      label={t(`compliance.status.${value}`, locale)}
      tone={l.tone}
      shape={l.shape}
      size={size}
      className={className}
    />
  );
}

/** Budget against actual spend. */
export function BudgetStatus({ value, locale, size = "sm", className }: Props) {
  if (!value) return null;
  const l = look(BUDGET_LOOK, value);
  return (
    <StatusBadge
      label={t(`budget.status.${value}`, locale)}
      tone={l.tone}
      shape={l.shape}
      size={size}
      className={className}
    />
  );
}
