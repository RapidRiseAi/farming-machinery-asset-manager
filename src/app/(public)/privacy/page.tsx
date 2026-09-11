import type { Metadata } from "next";

import { APP_NAME } from "@/lib/env";
import { PRIVACY } from "@/lib/legal";
import { LegalPage } from "../legal/legal-page";

export const metadata: Metadata = {
  title: `Privacy notice — ${APP_NAME}`,
  description: "What we hold, why, who else touches it, and what you can ask us to do about it.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy notice"
      intro="What we hold about you and your people, why we hold it, who else touches it, and what you can ask us to do about it. This is the POPIA notice."
      clauses={PRIVACY}
      otherHref="/terms"
      otherLabel="Terms of use"
    />
  );
}
