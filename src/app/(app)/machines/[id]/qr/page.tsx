import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";

export default async function MachineQrPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireProfile();
  const { id } = await params;

  const supabase = await createClient();
  const { data } = await supabase
    .from("machines")
    .select("name, public_token")
    .eq("id", id)
    .maybeSingle();
  const machine = data as { name: string; public_token: string } | null;
  if (!machine) notFound();

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const url = `${site}/m/${machine.public_token}`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 260 });

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="w-full self-start">
        <Link href={`/machines/${id}`} className="text-sm text-gray-500">
          ← {machine.name}
        </Link>
      </div>
      <div className="rounded-lg border border-gray-200 p-6 text-center print:border-0">
        <h1 className="mb-2 text-lg font-bold">{machine.name}</h1>
        <div className="mx-auto w-[260px]" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="mt-2 break-all text-xs text-gray-400">{url}</p>
        <p className="mt-1 text-xs text-gray-500">Scan to report a problem or log a reading</p>
      </div>
      <PrintButton />
      {!site ? (
        <p className="text-xs text-amber-600">
          Set NEXT_PUBLIC_SITE_URL so the QR points at your production URL.
        </p>
      ) : null}
    </div>
  );
}
