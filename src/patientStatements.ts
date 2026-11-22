import { z } from 'zod';
import { baseEnvelope } from './common.ts';
import {
  FeeCategory,
  type Charge,
  type Payment,
  type BillingAdjustment,
  type Refund,
} from './documents.ts';
import {
  currentAllocation,
  patientResponsibility,
  claimSettlement,
  type CoverageAllocation,
  type CoverageEstimate,
  type ClaimSettlement,
} from './insurance.ts';

const responsibilityText = (
  hasAllocation: boolean,
  hasSummary: boolean,
  isFinal: boolean,
): string => {
  if (hasAllocation) {
    return hasSummary ? 'Confirmed insurance decision' : 'Confirmed snapshot totals awaiting sync';
  }

  return isFinal ? 'Patient responsibility confirmed' : 'Insurance decision pending';
};

const paymentKindText = (payment: { reverses?: unknown; method: string }): string => {
  if (payment.reverses) {
    return 'Payment reversal';
  }

  return payment.method === 'waiver' ? 'Waiver' : `Patient ${payment.method} receipt`;
};

/** Public amounts copied from an existing immutable insurance snapshot; never contract terms. */
export const CoverageFinancialSummary = baseEnvelope
  .extend({
    type: z.literal('coverage_financial_summary'),
    allocationId: z.string().min(1),
    patientId: z.string().min(1),
    chargeId: z.string().min(1),
    currency: z.string(),
    listPriceMinor: z.number().int().nonnegative(),
    patientShareMinor: z.number().int().nonnegative(),
    payerShareMinor: z.number().int().nonnegative(),
    contractAdjustmentMinor: z.number().int(),
    capitationCoveredMinor: z.number().int().nonnegative(),
    returnAdjustmentMinor: z.number().int().nonnegative().default(0),
  })
  .refine(
    (s) =>
      s.listPriceMinor ===
      s.patientShareMinor +
        s.payerShareMinor +
        s.contractAdjustmentMinor +
        s.capitationCoveredMinor +
        s.returnAdjustmentMinor,
    'The existing insurance snapshot must reconcile',
  );

export type CoverageFinancialSummary = z.infer<typeof CoverageFinancialSummary>;

export type StatementClaim = {
  id: string;
  claimNumber: string;
  payerName: string;
  chargeIds: string[];
  settlement: ClaimSettlement;
};

export type StatementLine = {
  chargeId: string;
  category: z.infer<typeof FeeCategory>;
  description: string;
  createdOn: string;
  quantity?: number;
  unit?: string;
  unitPriceMinor?: number;
  originalMinor: number;
  exemptMinor: number;
  contractAdjustmentMinor: number;
  returnAdjustmentMinor: number;
  reductionsMinor: number;
  netMinor: number;
  patientMinor: number;
  payerMinor: number;
  capitationMinor: number;
  pendingMinor: number;
  patientReceivedMinor: number;
  patientRefundedMinor: number;
  patientBalanceMinor: number;
  heldPatientPaymentsMinor: number;
  responsibilityConfirmed: boolean;
  responsibility: string;
};

export const STATEMENT_TOTAL_KEYS = [
  'originalMinor',
  'exemptMinor',
  'contractAdjustmentMinor',
  'returnAdjustmentMinor',
  'reductionsMinor',
  'netMinor',
  'patientMinor',
  'payerMinor',
  'capitationMinor',
  'pendingMinor',
  'patientReceivedMinor',
  'patientRefundedMinor',
  'patientBalanceMinor',
  'heldPatientPaymentsMinor',
] as const;

export type StatementTotals = Record<(typeof STATEMENT_TOTAL_KEYS)[number], number>;

export const sumStatementLines = (lines: readonly StatementLine[]): StatementTotals =>
  Object.fromEntries(
    STATEMENT_TOTAL_KEYS.map((k) => [k, lines.reduce((n, l) => n + l[k], 0)]),
  ) as StatementTotals;

export type PatientStatement = {
  patientId: string;
  patientName: string;
  facilityName: string;
  currency: string;
  cutoff: string;
  generatedOn: string;
  lines: StatementLine[];
  categories: { category: z.infer<typeof FeeCategory>; count: number; totals: StatementTotals }[];
  totals: StatementTotals & {
    payerReceivedMinor: number;
    payerWrittenOffMinor: number;
    payerOutstandingMinor: number;
    patientOutstandingMinor: number;
    patientCreditMinor: number;
    payerUnclaimedMinor: number;
    payerCreditMinor: number;
  };
  claims: StatementClaim[];
  transactions: { id: string; on: string; kind: string; reference: string; amountMinor: number }[];
  limitations: string[];
};

/** One projection, used by every statement presentation. No insurer payment is assigned to a line. */
export const patientStatement = (input: {
  patientId: string;
  patientName: string;
  facilityName: string;
  currency: string;
  cutoff: string;
  generatedOn: string;
  charges: readonly Charge[];
  payments: readonly Payment[];
  adjustments: readonly BillingAdjustment[];
  refunds: readonly Refund[];
  allocations: readonly CoverageAllocation[];
  summaries: readonly CoverageFinancialSummary[];
  estimates: ReadonlyMap<string, CoverageEstimate>;
  claims: readonly StatementClaim[];
  limitations?: string[];
}): PatientStatement => {
  const before = (on: string) => Date.parse(on) <= Date.parse(input.cutoff);

  const charges = input.charges
    .filter(
      (c) =>
        c.patientId === input.patientId && c.currency === input.currency && before(c.createdOn),
    )
    .sort((a, b) => a.createdOn.localeCompare(b.createdOn) || a.id.localeCompare(b.id));

  const payments = input.payments.filter(
    (p) => p.patientId === input.patientId && p.currency === input.currency && before(p.createdOn),
  );

  const refunds = input.refunds.filter(
    (r) => r.patientId === input.patientId && r.currency === input.currency && before(r.createdOn),
  );

  const allocations = input.allocations.filter(
    (a) => a.patientId === input.patientId && before(a.createdOn),
  );

  const lines: StatementLine[] = charges.map((c) => {
    const allocation = currentAllocation(c.id, allocations);
    const summary = allocation && input.summaries.find((s) => s.allocationId === allocation.id);

    const estimate =
      input.estimates.get(c.id) ??
      ({ state: 'undetermined', reason: 'not_configured' } as CoverageEstimate);

    const responsibility = patientResponsibility(c, estimate);
    const exemptMinor = c.listPriceMinor - c.amountMinor;
    let patientMinor = 0;
    let payerMinor = 0;
    let capitationMinor = 0;
    let contractAdjustmentMinor = 0;
    let returnAdjustmentMinor = 0;
    let pendingMinor = 0;

    if (c.amountMinor === 0) {
      patientMinor = 0;
    } else if (allocation && summary) {
      patientMinor = summary.patientShareMinor;
      payerMinor = summary.payerShareMinor;
      capitationMinor = summary.capitationCoveredMinor;
      contractAdjustmentMinor = summary.contractAdjustmentMinor;
      returnAdjustmentMinor = summary.returnAdjustmentMinor;
    } else if (responsibility.final && !allocation) {
      patientMinor = responsibility.baseMinor;
    } else {
      pendingMinor = c.amountMinor;
    }

    // The signed contractual adjustment is subtracted. A negative value increases net charges.
    const signed = (p: Payment) => (p.reverses ? -1 : 1);

    const received = payments
      .filter((p) => p.method !== 'waiver')
      .reduce(
        (n, p) =>
          n +
          signed(p) *
            p.allocations.filter((a) => a.chargeId === c.id).reduce((s, a) => s + a.amountMinor, 0),
        0,
      );

    const waived = payments
      .filter((p) => p.method === 'waiver')
      .reduce(
        (n, p) =>
          n +
          signed(p) *
            p.allocations.filter((a) => a.chargeId === c.id).reduce((s, a) => s + a.amountMinor, 0),
        0,
      );

    const reductions = input.adjustments
      .filter((a) => a.patientId === input.patientId && a.chargeId === c.id && before(a.createdOn))
      .reduce((n, a) => n + a.amountMinor, waived);

    const refunded = refunds.reduce(
      (n, r) =>
        n + r.allocations.filter((a) => a.chargeId === c.id).reduce((s, a) => s + a.amountMinor, 0),
      0,
    );

    return {
      chargeId: c.id,
      category: c.category,
      description: c.description,
      createdOn: c.createdOn,
      quantity: c.quantity,
      unit: c.unitOfMeasure,
      unitPriceMinor: c.unitPriceMinor,
      originalMinor: c.listPriceMinor,
      exemptMinor,
      contractAdjustmentMinor,
      returnAdjustmentMinor,
      reductionsMinor: reductions,
      netMinor:
        c.listPriceMinor -
        exemptMinor -
        contractAdjustmentMinor -
        returnAdjustmentMinor -
        reductions,
      patientMinor,
      payerMinor,
      capitationMinor,
      pendingMinor,
      patientReceivedMinor: received,
      patientRefundedMinor: refunded,
      responsibilityConfirmed: pendingMinor === 0,
      heldPatientPaymentsMinor: pendingMinor > 0 ? Math.max(0, received - refunded) : 0,
      patientBalanceMinor: pendingMinor > 0 ? 0 : patientMinor - reductions - received + refunded,
      responsibility: responsibilityText(
        Boolean(allocation),
        Boolean(summary),
        responsibility.final,
      ),
    };
  });

  const totals = sumStatementLines(lines);
  const chargeIds = new Set(lines.map((l) => l.chargeId));
  const claims = input.claims.filter((c) => c.chargeIds.every((id) => chargeIds.has(id)));
  const claimed = new Set(claims.flatMap((c) => c.chargeIds));

  const unclaimed = lines
    .filter((l) => !claimed.has(l.chargeId))
    .reduce((n, l) => n + l.payerMinor, 0);

  const payerPaid = claims.reduce((n, c) => n + c.settlement.paidMinor, 0);
  const payerWriteOff = claims.reduce((n, c) => n + c.settlement.writtenOffMinor, 0);

  // Money stays with its recorded claim family; an overpayment cannot settle another claim.
  const payerPositions = claims.map((c) => {
    const expectedMinor = lines
      .filter((l) => c.chargeIds.includes(l.chargeId))
      .reduce((n, l) => n + l.payerMinor, 0);

    return {
      position: claimSettlement({
        submitted: true,
        expectedMinor,
        paidMinor: c.settlement.paidMinor,
        writtenOffMinor: c.settlement.writtenOffMinor,
        openDisputeMinor: 0,
        today: input.cutoff.slice(0, 10),
      }),
      creditMinor: Math.max(0, c.settlement.paidMinor - expectedMinor),
    };
  });

  const mismatch =
    claims.reduce((n, c) => n + c.settlement.expectedMinor, 0) !== totals.payerMinor - unclaimed;

  return {
    patientId: input.patientId,
    patientName: input.patientName,
    facilityName: input.facilityName,
    currency: input.currency,
    cutoff: input.cutoff,
    generatedOn: input.generatedOn,
    lines,
    categories: FeeCategory.options.flatMap((category) => {
      const group = lines.filter((l) => l.category === category);

      return group.length
        ? [{ category, count: group.length, totals: sumStatementLines(group) }]
        : [];
    }),
    totals: {
      ...totals,
      payerReceivedMinor: payerPaid,
      payerWrittenOffMinor: payerWriteOff,
      payerOutstandingMinor:
        unclaimed + payerPositions.reduce((n, p) => n + p.position.outstandingMinor, 0),
      payerCreditMinor: payerPositions.reduce((n, p) => n + p.creditMinor, 0),
      patientOutstandingMinor: lines.reduce((n, l) => n + Math.max(0, l.patientBalanceMinor), 0),
      patientCreditMinor: lines.reduce((n, l) => n + Math.max(0, -l.patientBalanceMinor), 0),
      payerUnclaimedMinor: unclaimed,
    },
    claims,
    transactions: [
      ...charges.map((c) => ({
        id: c.id,
        on: c.createdOn,
        kind: 'Hospital charge',
        reference: c.description,
        amountMinor: c.listPriceMinor,
      })),
      ...input.adjustments
        .filter(
          (a) =>
            a.patientId === input.patientId && chargeIds.has(a.chargeId) && before(a.createdOn),
        )
        .map((a) => ({
          id: a.id,
          on: a.createdOn,
          kind: a.kind === 'discount' ? 'Discount or return credit' : 'Waiver',
          reference: a.reason,
          amountMinor: -a.amountMinor,
        })),
      ...payments.map((p) => ({
        id: p.id,
        on: p.createdOn,
        kind: paymentKindText(p),
        reference: p.receiptNumber,
        amountMinor: p.amountMinor * (p.reverses ? -1 : 1),
      })),
      ...refunds.map((r) => ({
        id: r.id,
        on: r.createdOn,
        kind: 'Patient refund',
        reference: r.refundNumber,
        amountMinor: -r.amountMinor,
      })),
    ].sort((a, b) => a.on.localeCompare(b.on)),
    limitations: [
      ...(input.limitations ?? []),
      ...(mismatch
        ? [
            'A claim snapshot differs from the current confirmed responsibility. Insurance staff must reconcile its revision; no difference is automatically charged to the patient.',
          ]
        : []),
    ],
  };
};
