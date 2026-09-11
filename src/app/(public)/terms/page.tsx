import type { Metadata } from "next";

import { APP_NAME } from "@/lib/env";
import { TERMS } from "@/lib/legal";
import { LegalPage } from "../legal/legal-page";

export const metadata: Metadata = {
  title: `Terms of use — ${APP_NAME}`,
  description: "What you get, what it costs, and what happens if you stop paying.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      intro="What you get, what it costs, what happens if a payment fails, and what happens to your records. Written to describe what the software actually does."
      clauses={TERMS}
      otherHref="/privacy"
      otherLabel="Privacy notice"
    />
  );
}
