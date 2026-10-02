/**
 * The farm set-up checklist, as one list that `/onboarding` and the dashboard both read.
 *
 * Two screens computing "3 of 4 done" separately is how they come to disagree, so the
 * steps, their done-conditions and where each one sends you live here.
 */

export type SetupCounts = {
  machines: number;
  plans: number;
  qrLabelsDone: boolean;
  users: number;
};

export type SetupStep = {
  key: "step1" | "step2" | "step3" | "step4";
  done: boolean;
  cta: string;
  ctaKey: string;
  alt?: string;
  altKey?: string;
  /** Step 3 is ticked by hand: nothing in the data proves the stickers are on. */
  ack?: boolean;
};

export function setupSteps(c: SetupCounts): SetupStep[] {
  return [
    { key: "step1", done: c.machines > 0, cta: "/machines/new", ctaKey: "onboarding.step1Cta", alt: "/machines/import", altKey: "onboarding.step1Alt" },
    // Service plans are applied on a machine's Servicing tab. The list opens filtered to
    // the machines that still have none, and each row's "Set up a plan" goes there.
    { key: "step2", done: c.plans > 0, cta: "/machines?service=none", ctaKey: "onboarding.step2Cta" },
    // Straight to the farm's label sheet: every sticker on one page, plus the button
    // that ticks this step once they are on.
    {
      key: "step3",
      done: c.qrLabelsDone,
      cta: "/machines/qr",
      ctaKey: "onboarding.step3Cta",
      ack: true,
    },
    { key: "step4", done: c.users > 1, cta: "/team", ctaKey: "onboarding.step4Cta" },
  ];
}
