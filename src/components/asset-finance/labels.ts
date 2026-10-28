import { t, type Lang } from "@/lib/i18n";

/**
 * Words for the finance vocabulary. Each value has its key written out in full, so a value
 * with no translation is a missing key the i18n gate can see, never a raw enum on screen
 * (the `enumLabel` failure CLAUDE.md records). Unknown values fall back to "Other".
 */

const AGREEMENT_KIND_KEYS: Record<string, string> = {
  instalment_sale: "assetFinance.agreementKindInstalmentSale",
  loan: "assetFinance.agreementKindLoan",
  finance_lease: "assetFinance.agreementKindFinanceLease",
  other: "assetFinance.agreementKindOther",
};

const CONTRACT_KIND_KEYS: Record<string, string> = {
  operating_lease: "assetFinance.contractKindOperatingLease",
  rental: "assetFinance.contractKindRental",
  service_contract: "assetFinance.contractKindServiceContract",
  maintenance_plan: "assetFinance.contractKindMaintenancePlan",
  extended_warranty: "assetFinance.contractKindExtendedWarranty",
  insurance: "assetFinance.contractKindInsurance",
  other: "assetFinance.contractKindOther",
};

const FREQUENCY_KEYS: Record<string, string> = {
  monthly: "assetFinance.frequencyMonthly",
  quarterly: "assetFinance.frequencyQuarterly",
  biannual: "assetFinance.frequencyBiannual",
  annual: "assetFinance.frequencyAnnual",
  once: "assetFinance.frequencyOnce",
};

const AGREEMENT_STATUS_KEYS: Record<string, string> = {
  active: "assetFinance.statusActive",
  settled: "assetFinance.statusSettled",
  cancelled: "assetFinance.statusCancelled",
};

const CONTRACT_STATUS_KEYS: Record<string, string> = {
  active: "assetFinance.statusActive",
  ended: "assetFinance.statusEnded",
  cancelled: "assetFinance.statusCancelled",
};

const INSTALMENT_STATUS_KEYS: Record<string, string> = {
  open: "assetFinance.instalmentOpen",
  paid: "assetFinance.instalmentPaid",
  settled: "assetFinance.instalmentSettled",
};

const COMMITMENT_KIND_KEYS: Record<string, string> = {
  instalment: "assetFinance.commitmentInstalment",
  balloon: "assetFinance.commitmentBalloon",
  contract_payment: "assetFinance.commitmentContractPayment",
  contract_notice: "assetFinance.commitmentContractNotice",
  contract_end: "assetFinance.commitmentContractEnd",
};

export function agreementKindLabel(kind: string, locale: Lang): string {
  return t(AGREEMENT_KIND_KEYS[kind] ?? AGREEMENT_KIND_KEYS.other, locale);
}

export function contractKindLabel(kind: string, locale: Lang): string {
  return t(CONTRACT_KIND_KEYS[kind] ?? CONTRACT_KIND_KEYS.other, locale);
}

export function frequencyLabel(frequency: string, locale: Lang): string {
  return t(FREQUENCY_KEYS[frequency] ?? FREQUENCY_KEYS.monthly, locale);
}

export function agreementStatusLabel(status: string, locale: Lang): string {
  return t(AGREEMENT_STATUS_KEYS[status] ?? AGREEMENT_STATUS_KEYS.active, locale);
}

export function contractStatusLabel(status: string, locale: Lang): string {
  return t(CONTRACT_STATUS_KEYS[status] ?? CONTRACT_STATUS_KEYS.active, locale);
}

export function instalmentStatusLabel(status: string, locale: Lang): string {
  return t(INSTALMENT_STATUS_KEYS[status] ?? INSTALMENT_STATUS_KEYS.open, locale);
}

export function commitmentKindLabel(kind: string, locale: Lang): string {
  return t(COMMITMENT_KIND_KEYS[kind] ?? COMMITMENT_KIND_KEYS.instalment, locale);
}

/** Every key above, for the test that walks them in both languages. */
export const FINANCE_LABEL_KEYS: readonly string[] = [
  ...Object.values(AGREEMENT_KIND_KEYS),
  ...Object.values(CONTRACT_KIND_KEYS),
  ...Object.values(FREQUENCY_KEYS),
  ...Object.values(AGREEMENT_STATUS_KEYS),
  ...Object.values(CONTRACT_STATUS_KEYS),
  ...Object.values(INSTALMENT_STATUS_KEYS),
  ...Object.values(COMMITMENT_KIND_KEYS),
];
