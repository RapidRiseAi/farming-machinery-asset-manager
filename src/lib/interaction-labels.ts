import { t, type Lang } from "@/lib/i18n";
import type { DownloadFailure } from "@/lib/download";

/**
 * The words `DownloadLink` and `ActionButton` need, translated on the server and passed
 * down as plain strings. The client pieces never import the dictionaries themselves:
 * they are on most screens, and the dictionaries are larger than the rest of a page's
 * scripts together.
 */
export type DownloadLabels = Record<DownloadFailure, string> & {
  preparing: string;
  offline: string;
  dismiss: string;
};

export function downloadLabels(locale: Lang): DownloadLabels {
  return {
    preparing: t("interaction.downloadPreparing", locale),
    offline: t("interaction.downloadOffline", locale),
    dismiss: t("ui.dismiss", locale),
    "signed-out": t("interaction.downloadSignedOut", locale),
    "not-allowed": t("interaction.downloadNotAllowed", locale),
    "not-found": t("interaction.downloadNotFound", locale),
    busy: t("interaction.downloadBusy", locale),
    failed: t("interaction.downloadFailed", locale),
  };
}

export type ActionLabels = {
  working: string;
  failed: string;
  offline: string;
  dismiss: string;
};

export function actionLabels(locale: Lang): ActionLabels {
  return {
    working: t("interaction.working", locale),
    failed: t("interaction.actionFailed", locale),
    offline: t("interaction.actionOffline", locale),
    dismiss: t("ui.dismiss", locale),
  };
}
