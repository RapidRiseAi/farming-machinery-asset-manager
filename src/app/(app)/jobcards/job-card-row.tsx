"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Tr } from "@/components/ui/table";

/** The real link inside the row remains keyboard accessible and supports new tabs. */
export function JobCardRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <Tr
      className="cursor-pointer focus-within:bg-surface-hover"
      onClick={(event) => {
        if (event.defaultPrevented || (event.target as HTMLElement).closest("a, button, input, select, textarea")) return;
        if (event.ctrlKey || event.metaKey) window.open(href, "_blank", "noopener,noreferrer");
        else router.push(href);
      }}
    >
      {children}
    </Tr>
  );
}
