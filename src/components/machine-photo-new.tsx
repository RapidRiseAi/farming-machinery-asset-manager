"use client";

import { t, type Lang } from "@/lib/i18n";
import { UploadField } from "@/components/upload/upload-field";

/**
 * Add-vehicle primary-photo picker. The page chooses the new vehicle's id, so the photo
 * goes straight to Storage under it through the upload pipeline (reduced unless the
 * original is kept) while the rest of the form is filled in; the form then sends the
 * upload's id as `primary_photo_intent`, and `createMachine` judges and saves it once the
 * vehicle exists and marks it primary. Keeps the add flow one submit, with no photo
 * passing through a server function.
 */
export function MachinePhotoNew({ locale = "en", farmId, machineId }: { locale?: Lang; farmId: string | null; machineId: string }) {
  return (
    <UploadField
      locale={locale}
      label={t("machines.choosePhoto", locale)}
      accept="photo"
      capture
      uploadLabel="photo"
      finish="caller"
      name="primary_photo_intent"
      scope={`new-machine:${machineId}`}
      target={farmId ? { kind: "machine", id: machineId, farmId } : null}
    />
  );
}
