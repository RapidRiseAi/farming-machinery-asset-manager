"use client";

import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { UploadField } from "@/components/upload/upload-field";

/** A manual (PDF) onto this asset, through the upload pipeline; the card re-reads once it is saved. */
export function ManualUpload({ farmId, machineId, label, locale }: { farmId: string; machineId: string; label: string; locale: Lang }) {
  const router = useRouter();
  return (
    <UploadField
      locale={locale}
      label={label}
      accept="document"
      uploadLabel="manual"
      finish="generic"
      attachmentKind="doc"
      scope={`machine-manual:${machineId}`}
      target={{ kind: "machine", id: machineId, farmId }}
      onDone={() => router.refresh()}
    />
  );
}
