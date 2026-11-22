import { LEGACY_FEE_CATEGORIES, type Charge, type FeeCategory } from './documents.ts';
import type { UploadMutation } from './api.ts';

/** Suggestions only: discovery and permission to perform clinical work are separate. */
export const BILLING_CATEGORY_SUGGESTIONS = {
  laboratory: 'laboratory',
  pharmacy: 'pharmacy',
  consultation: 'consultation',
  maternity: 'maternity',
  admission: 'admission',
  procedure: 'procedure',
  imaging: 'imaging',
} as const satisfies Record<string, FeeCategory>;

export const isLegacyFeeCategory = (category: unknown) =>
  (LEGACY_FEE_CATEGORIES as readonly unknown[]).includes(category);

export const usesBillingCatalogue = (m: UploadMutation): boolean => {
  const data = m.data;

  if (
    ['fee_item', 'charge'].includes(m.table) &&
    data.category !== undefined &&
    !isLegacyFeeCategory(data.category)
  ) {
    return true;
  }

  if (
    m.table === 'charge' &&
    ['feePriceVersion', 'quantity', 'unitPriceMinor', 'servicePointId'].some(
      (key) => data[key] !== undefined,
    )
  ) {
    return true;
  }

  if (m.table === 'service_definition' && data.feeItemId !== undefined) {
    return true;
  }

  const values = data.values as
    { items?: { catalogueSource?: string }[]; supply?: { catalogueVersion?: number } } | undefined;

  return (
    m.table === 'encounter_entry' &&
    Boolean(
      values?.supply?.catalogueVersion === 1 ||
      values?.items?.some((i) => i.catalogueSource === 'billing'),
    )
  );
};

/** Candidates require review, never establish that a bill covers an activity. */
export const manualBillCandidates = (
  charges: readonly Charge[],
  patientId: string,
  feeItemId: string,
  encounterId?: string,
) =>
  charges.filter(
    (c) =>
      c.patientId === patientId &&
      c.feeItemId === feeItemId &&
      !c.orderItemId &&
      !c.dispenseEntryId &&
      (!encounterId || !c.encounterId || c.encounterId === encounterId),
  );
