"use client";
import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
export function DrivingLocation({ locale }: { locale: Lang }) {
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(
    null,
  );
  const [status, setStatus] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name="lat" value={position?.lat ?? ""} />
      <input type="hidden" name="lng" value={position?.lng ?? ""} />
      <button
        type="button"
        className="min-h-12 rounded-lg border border-sand-300 px-3"
        onClick={() => {
          setStatus(t("driving.locating", locale));
          if (!navigator.geolocation) {
            setStatus(t("driving.geoFailed", locale));
            return;
          }
          navigator.geolocation.getCurrentPosition(
            (p) => {
              setPosition({ lat: p.coords.latitude, lng: p.coords.longitude });
              setStatus(t("driving.geoSaved", locale));
            },
            () => setStatus(t("driving.geoFailed", locale)),
            { timeout: 10000, maximumAge: 0 },
          );
        }}
      >
        {t("driving.useLocation", locale)}
      </button>
      <p role="status" className="text-sm text-ink-muted">
        {status}
      </p>
    </div>
  );
}
