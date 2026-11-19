import { t, type Lang } from "@/lib/i18n";

/** Every word the route recorder shows, in the browser and in the Android app (B6). */
export function recorderLabels(locale: Lang) {
  return {
    start: t("map.recordStart", locale),
    stop: t("map.recordStop", locale),
    recording: t("map.recording", locale),
    keepOpen: t("map.keepOpen", locale),
    denied: t("map.recordDenied", locale),
    // The Android app: recording continues with the screen locked, through a notification.
    nativeDisclosure: t("map.nativeDisclosure", locale),
    nativeRecording: t("map.nativeRecording", locale),
    nativeQueued: t("map.nativeQueued", locale),
    nativeDenied: t("map.nativeDenied", locale),
    nativeEnded: t("map.nativeEnded", locale),
    openSettings: t("map.openSettings", locale),
    notificationTitle: t("map.notificationTitle", locale),
    notificationMessage: t("map.notificationMessage", locale),
  };
}

export type RecorderLabels = ReturnType<typeof recorderLabels>;
