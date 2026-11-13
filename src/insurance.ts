/**
 * Geneus Health — shared contract: insurance and HMO cover (PRODUCT.md §7.10;
 * docs/INSURANCE-HMO-PLAN.md, Slice 1).
 *
 * Three tiers of data, kept apart on purpose:
 *
 *   commercial   — `PayerContractVersion`: tariffs, payer shares, full plan
 *                  rules. Server-only; never a synced record type.
 *   schedule     — `CoverSchedule`: per fee item, whether it is covered and
 *                  what the PATIENT pays. Derived by the server at activation
 *                  and synced, so cashiers can work offline.
 *   allocation   — `CoverageAllocation`: the confirmed patient share of one
 *                  charge. The full snapshot (inputs, payer share, contract
 *                  adjustment) stays in server-only columns.
 *
 * No payer, price, entitlement, deadline or liability rule ships with Geneus.
 * Every missing fact resolves to an explicit `undetermined` state, never a
 * default that could bill a patient or create an HMO receivable.
 *
 * Calculation version 1 is defined here and nowhere else. The device and the
 * server run the same functions, so an offline estimate and the server's
 * confirmation cannot disagree on arithmetic. Where an exact figure cannot be
 * produced — an unknown quantity, a missing tariff, an unsupported arrangement
 * — the result is `undetermined`, never an approximation.
 */
import { z } from 'zod';
import { baseEnvelope, isoDate, patientId } from './common.ts';
import { FeeCategory, currencyCode, minorUnits, type Charge, type EncounterEntry } from './documents.ts';
import { dispensingDetails } from './pharmacy.ts';

const text = z.string().trim().min(1);

/** Negotiated with devices and the server, like the pharmacy and ward-care workflows. */
export const INSURANCE_WORKFLOW_VERSION = 1 as const;
/**
 * A hospital's insurance state. `setup` lets authorised staff prepare payers,
 * contracts, documents, imports and submission settings without changing a
 * single patient balance. Only `active` applies cover to bills, and only an
 * operator moves a hospital there, after the server's readiness checks.
 * Leaving `active` keeps every confirmed obligation (confirmed splits stay).
 */
export const InsuranceState = z.enum(['off', 'setup', 'active']);
export type InsuranceState = z.infer<typeof InsuranceState>;
export const insuranceConfigurable = (state: InsuranceState | undefined) => state === 'setup' || state === 'active';

/** Insurance records a device may upload; every other insurance record is server-written. */
export const INSURANCE_UPLOAD_TYPES = ['patient_cover', 'cover_check', 'coverage_election'] as const;
/**
 * Synced only to devices that negotiated the insurance workflow: an older client
 * cannot read them, so it never receives them. Refunds ride with them because an
 * older client could not subtract them from a balance.
 */
export const INSURANCE_SYNCED_TYPES = ['payer', 'cover_schedule', 'patient_cover', 'cover_check', 'coverage_election', 'coverage_allocation', 'refund'] as const;
/** Stored on every confirmed snapshot. A change to the arithmetic is a new version. */
export const CALCULATION_VERSION = 1 as const;

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export const PayerKind = z.enum(['national_scheme', 'state_scheme', 'hmo', 'company', 'other']);
export type PayerKind = z.infer<typeof PayerKind>;

/**
 * Whether a covered member may choose to pay without their insurance for a
 * service. Unset means the hospital has not recorded the payer's rule: the
 * till cannot offer it, and only an insurance officer may decide it with a
 * reason. `not_allowed` is a contractual prohibition nobody can override.
 */
export const SelfPayElectionRule = z.enum(['allowed', 'not_allowed']);
export type SelfPayElectionRule = z.infer<typeof SelfPayElectionRule>;

export const Arrangement = z.enum(['per_service', 'capitation', 'per_diem', 'package']);
export type Arrangement = z.infer<typeof Arrangement>;
/** Calculated in calculation version 1. The others are modelled and never produce money. */
export const SUPPORTED_ARRANGEMENTS = ['per_service', 'capitation'] as const satisfies readonly Arrangement[];
export const isSupportedArrangement = (arrangement: Arrangement): arrangement is (typeof SUPPORTED_ARRANGEMENTS)[number] =>
  (SUPPORTED_ARRANGEMENTS as readonly Arrangement[]).includes(arrangement);

/** Basis points: 1000 = 10%. Integer, so rounding is defined, not floating. */
const basisPoints = z.number().int().min(0).max(10_000);

/**
 * What a fixed co-payment is charged against, exactly as the contract states it.
 * Calculation version 1 calculates only `per_unit` (3 units owe 3 × the amount).
 * A co-pay once per charge, dispense, visit or claim is recorded as such and
 * leaves the charge undetermined — it is never approximated as per unit.
 */
export const FixedCopayBasis = z.enum(['per_unit', 'per_charge', 'per_dispense', 'per_visit', 'per_claim']);
export type FixedCopayBasis = z.infer<typeof FixedCopayBasis>;

/** A percentage applies to the tariff of the units supplied, so it needs no basis. */
export const Copay = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('percent'), basisPoints }),
  z.strictObject({ kind: z.literal('fixed'), amountMinor: minorUnits, basis: FixedCopayBasis }),
]);
export type Copay = z.infer<typeof Copay>;

/**
 * One plan rule. An excluded service bills the patient only when the contract
 * says so (`patient_pays`); `not_billable` means the hospital may not bill the
 * patient for it; unset means the hospital has not recorded which applies.
 */
export const PlanRule = z.discriminatedUnion('coverage', [
  z.strictObject({ coverage: z.literal('covered'), copay: Copay, approvalRequired: z.boolean().default(false), limitNote: text.max(500).optional() }),
  z.strictObject({ coverage: z.literal('excluded'), patientLiability: z.enum(['patient_pays', 'not_billable']).optional() }),
]);
export type PlanRule = z.infer<typeof PlanRule>;

const feeItemKey = z.string().min(1).max(200);
const planCode = z.string().trim().min(1).max(60);

/* ------------------------------------------------------------------ */
/* Commercial tier — server only                                       */
/* ------------------------------------------------------------------ */

export const ContractPlan = z.strictObject({
  planCode,
  name: text.max(200),
  rules: z.strictObject({
    categories: z.partialRecord(FeeCategory, PlanRule).default({}),
    items: z.record(feeItemKey, PlanRule).default({}),
  }),
});
export type ContractPlan = z.infer<typeof ContractPlan>;

/** What a hospital edits. Ids, versions and status are the server's. */
export const PayerContractTerms = z.strictObject({
  payerId: z.string().min(1),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  currency: currencyCode,
  arrangements: z.strictObject({
    categories: z.partialRecord(FeeCategory, Arrangement).default({}),
    items: z.record(feeItemKey, Arrangement).default({}),
  }),
  /** Negotiated price per unit, by fee item, with the payer's own service code for claims. */
  tariff: z.record(feeItemKey, z.strictObject({ unitMinor: minorUnits, payerCode: text.max(60).optional() })).default({}),
  plans: z.array(ContractPlan).min(1).max(50),
  /**
   * Whether a covered member may choose to pay without their insurance under
   * this contract. Versioned with the contract, so a choice is judged by the
   * rule in force on the date of service. Unset: not offered at the till.
   */
  selfPayElection: SelfPayElectionRule.optional(),
  note: text.max(2000).optional(),
}).superRefine((terms, context) => {
  if (terms.effectiveTo && terms.effectiveTo < terms.effectiveFrom) context.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'The contract must end on or after it starts' });
  const codes = terms.plans.map((plan) => plan.planCode);
  if (new Set(codes).size !== codes.length) context.addIssue({ code: 'custom', path: ['plans'], message: 'Each plan code must be unique in a contract' });
});
export type PayerContractTerms = z.infer<typeof PayerContractTerms>;

/** One immutable version once active. Id convention `${contractId}:v${version}`. */
export const PayerContractVersion = z.strictObject({
  id: z.string().min(1),
  facilityId: z.string().min(1),
  contractId: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(['draft', 'active']),
  terms: PayerContractTerms,
  revision: z.number().int().positive(),
  createdBy: z.string().min(1),
  createdOn: z.string().min(1),
  updatedBy: z.string().min(1).optional(),
  updatedOn: z.string().min(1).optional(),
  activatedBy: z.string().min(1).optional(),
  activatedOn: z.string().min(1).optional(),
  /** Set once, by ending the contract; never before today, so history is unchanged. */
  endedOn: z.string().min(1).optional(),
  endedBy: z.string().min(1).optional(),
  endReason: z.string().min(1).optional(),
});
export type PayerContractVersion = z.infer<typeof PayerContractVersion>;
export const contractIdFor = (payerId: string) => `contract:${payerId}`;
export const contractVersionId = (contractId: string, version: number) => `${contractId}:v${version}`;

/* ------------------------------------------------------------------ */
/* Patient-facing tier — synced                                        */
/* ------------------------------------------------------------------ */

/**
 * What the patient pays for one charge, without the tariff. `per_unit` is a
 * precomputed amount per unit; the other two are formulas the patient could be
 * told outright. A percentage of a confidential tariff is never sent as a
 * percentage — only as its per-unit result.
 */
export const PatientAmount = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('per_unit'), amountMinor: minorUnits }),
  z.strictObject({ kind: z.literal('percent_of_list'), basisPoints }),
  z.strictObject({ kind: z.literal('fixed_per_unit_capped_at_list'), amountMinor: minorUnits }),
]);
export type PatientAmount = z.infer<typeof PatientAmount>;

export const NotConfiguredPart = z.enum(['arrangement', 'rule', 'tariff']);
export const ScheduleLine = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('covered'), arrangement: z.enum(SUPPORTED_ARRANGEMENTS), patient: PatientAmount, approvalRequired: z.boolean() }),
  z.strictObject({ status: z.literal('excluded'), patientLiability: z.enum(['patient_pays', 'not_billable', 'not_configured']) }),
  z.strictObject({ status: z.literal('not_configured'), missing: NotConfiguredPart }),
  z.strictObject({ status: z.literal('unsupported'), feature: z.enum(['per_diem', 'package', 'copay_per_charge', 'copay_per_dispense', 'copay_per_visit', 'copay_per_claim']) }),
]);
export type ScheduleLine = z.infer<typeof ScheduleLine>;

export const Payer = baseEnvelope.extend({
  type: z.literal('payer'),
  name: text.max(200),
  kind: PayerKind,
  /** Short code staff recognise on a card or list. */
  code: z.string().trim().min(1).max(30),
  active: z.boolean().default(true),
});
export type Payer = z.infer<typeof Payer>;

/** Server-written when a contract version is activated: one per plan. Insert-only. */
export const CoverSchedule = baseEnvelope.extend({
  type: z.literal('cover_schedule'),
  payerId: z.string().min(1),
  contractId: z.string().min(1),
  contractVersionId: z.string().min(1),
  contractVersion: z.number().int().positive(),
  planCode,
  planName: text.max(200),
  currency: currencyCode,
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  /** Set once when an administrator ends the contract; services after it are not covered by this schedule. */
  endedOn: isoDate.optional(),
  selfPayElection: SelfPayElectionRule.optional(),
  calculationVersion: z.literal(CALCULATION_VERSION),
  items: z.record(feeItemKey, ScheduleLine),
  categories: z.partialRecord(FeeCategory, ScheduleLine),
});
export type CoverSchedule = z.infer<typeof CoverSchedule>;

/** A patient's membership of a payer plan. Insert-only: a change is a new record that `replaces` the old. */
export const PatientCover = baseEnvelope.extend({
  type: z.literal('patient_cover'),
  patientId,
  payerId: z.string().min(1),
  planCode,
  enrolleeNumber: z.string().trim().min(1).max(60),
  relationship: z.enum(['principal', 'dependant']),
  principalName: text.max(200).optional(),
  validFrom: isoDate.optional(),
  validTo: isoDate.optional(),
  active: z.boolean(),
  replaces: z.string().min(1).optional(),
}).refine((cover) => !cover.validFrom || !cover.validTo || cover.validFrom <= cover.validTo, { message: 'Cover must end on or after it starts', path: ['validTo'] });
export type PatientCover = z.infer<typeof PatientCover>;

export const CoverCheckMethod = z.enum(['portal', 'phone', 'email', 'card_seen', 'letter', 'other']);
/** Evidence that someone checked cover, and for which dates. Insert-only. */
export const CoverCheck = baseEnvelope.extend({
  type: z.literal('cover_check'),
  patientId,
  coverId: z.string().min(1),
  method: CoverCheckMethod,
  reference: text.max(200).optional(),
  result: z.enum(['verified', 'pending', 'not_eligible']),
  /** The dates the checker confirmed. Geneus never assumes how long a check lasts. */
  coversFrom: isoDate,
  coversTo: isoDate,
  note: text.max(1000).optional(),
}).refine((check) => check.coversFrom <= check.coversTo, { message: 'The checked period must end on or after it starts', path: ['coversTo'] });
export type CoverCheck = z.infer<typeof CoverCheck>;

/**
 * A recorded choice at the desk. `use_cover` picks which cover applies when
 * more than one is valid. `self_pay` is the patient choosing to pay without
 * insurance — offered only when the payer's rule allows it, or when a check
 * found the patient not eligible. Insert-only.
 */
export const CoverageElection = baseEnvelope.extend({
  type: z.literal('coverage_election'),
  patientId,
  kind: z.enum(['use_cover', 'self_pay']),
  coverId: z.string().min(1),
  chargeIds: z.array(z.string().min(1)).min(1).max(200),
  reason: z.enum(['patient_choice', 'not_eligible']).optional(),
  coverCheckId: z.string().min(1).optional(),
  patientAgreed: z.literal(true).optional(),
  note: text.max(1000).optional(),
}).superRefine((election, context) => {
  if (new Set(election.chargeIds).size !== election.chargeIds.length) context.addIssue({ code: 'custom', path: ['chargeIds'], message: 'Name each charge once' });
  if (election.kind === 'self_pay') {
    if (!election.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'Say why the patient is paying without insurance' });
    if (!election.patientAgreed) context.addIssue({ code: 'custom', path: ['patientAgreed'], message: 'Record that the patient agreed to pay' });
    if (election.reason === 'not_eligible' && !election.coverCheckId) context.addIssue({ code: 'custom', path: ['coverCheckId'], message: 'Name the check that found the patient not eligible' });
  } else if (election.reason || election.coverCheckId || election.patientAgreed) {
    context.addIssue({ code: 'custom', path: ['kind'], message: 'Choosing a cover records no self-pay details' });
  }
});
export type CoverageElection = z.infer<typeof CoverageElection>;

/**
 * The patient-facing projection of a confirmed snapshot. The payer share,
 * contract adjustment, capitation-covered amount and calculation inputs live
 * only in server columns. `arrangement` says whether the remainder is an HMO
 * receivable (`per_service`) or covered by capitation; it never carries an
 * amount, so no visit-level receivable can be summed from synced data.
 */
export const CoverageAllocation = baseEnvelope.extend({
  type: z.literal('coverage_allocation'),
  patientId,
  chargeId: z.string().min(1),
  state: z.enum(['finalised', 'self_pay_confirmed']),
  payerId: z.string().min(1).optional(),
  arrangement: z.enum(SUPPORTED_ARRANGEMENTS).optional(),
  patientShareMinor: minorUnits,
  currency: currencyCode,
  basis: z.enum(['visit', 'routine_bulk', 'exception']),
  supersedes: z.string().min(1).optional(),
});
export type CoverageAllocation = z.infer<typeof CoverageAllocation>;

/* ------------------------------------------------------------------ */
/* Arithmetic — calculation version 1                                  */
/* ------------------------------------------------------------------ */

/** Half-up rounding to a whole minor unit, for non-negative amounts. */
export const roundHalfUp = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new Error('Amounts must be finite and non-negative');
  return Math.floor(value + 0.5 + 1e-9);
};
/** Integer percentage of an integer amount, half up, with no floating-point step. */
export const percentOf = (amountMinor: number, bp: number): number => Math.floor((amountMinor * bp + 5_000) / 10_000);

/** A co-pay calculation version 1 can perform: none, a percentage, or a fixed amount per unit. */
export const calculableCopay = (copay: Copay): boolean => copay.kind !== 'fixed' || copay.basis === 'per_unit';
type CopayFeature = 'copay_per_charge' | 'copay_per_dispense' | 'copay_per_visit' | 'copay_per_claim';
const unsupportedCopay = (copay: Copay): CopayFeature | undefined => (copay.kind === 'fixed' && copay.basis !== 'per_unit' ? (`copay_${copay.basis}` as CopayFeature) : undefined);

/** The per-unit patient amount a co-pay gives on a tariff. Never more than the tariff. Callers check `calculableCopay` first. */
export const copayPerUnit = (copay: Copay, unitTariffMinor: number): number => {
  if (!calculableCopay(copay)) throw new Error('This co-pay basis is not calculable in version 1');
  return copay.kind === 'none' ? 0 : copay.kind === 'percent' ? percentOf(unitTariffMinor, copay.basisPoints) : Math.min(copay.amountMinor, unitTariffMinor);
};

/** The patient's share of one charge from a schedule line amount. Same formula on device and server. */
export const patientShareFor = (amount: PatientAmount, units: number, listPriceMinor: number): number => {
  if (amount.kind === 'per_unit') return roundHalfUp(amount.amountMinor * units);
  if (amount.kind === 'percent_of_list') return percentOf(listPriceMinor, amount.basisPoints);
  return Math.min(roundHalfUp(amount.amountMinor * units), listPriceMinor);
};

type Resolved = { arrangement?: Arrangement; rule?: PlanRule; tariffMinor?: number };
const resolveTerms = (terms: PayerContractTerms, plan: ContractPlan, feeItemId: string | undefined, category: FeeCategory): Resolved => ({
  arrangement: (feeItemId ? terms.arrangements.items[feeItemId] : undefined) ?? terms.arrangements.categories[category],
  rule: (feeItemId ? plan.rules.items[feeItemId] : undefined) ?? plan.rules.categories[category],
  tariffMinor: feeItemId ? terms.tariff[feeItemId]?.unitMinor : undefined,
});

/**
 * The schedule line for one fee item (or, without one, for a whole category).
 * A category line can only be `covered` where no tariff is needed: capitation
 * with no co-pay or a co-pay on the list price. Per-service cover needs a tariff
 * per fee item, so a category line for it is `not_configured`.
 */
export const scheduleLineFor = (terms: PayerContractTerms, plan: ContractPlan, feeItemId: string | undefined, category: FeeCategory): ScheduleLine => {
  const { arrangement, rule, tariffMinor } = resolveTerms(terms, plan, feeItemId, category);
  if (rule?.coverage === 'excluded') return { status: 'excluded', patientLiability: rule.patientLiability ?? 'not_configured' };
  if (!arrangement) return { status: 'not_configured', missing: 'arrangement' };
  if (!isSupportedArrangement(arrangement)) return { status: 'unsupported', feature: arrangement };
  if (!rule) return { status: 'not_configured', missing: 'rule' };
  const copayFeature = unsupportedCopay(rule.copay);
  if (copayFeature) return { status: 'unsupported', feature: copayFeature };
  const approvalRequired = rule.approvalRequired;
  if (tariffMinor !== undefined) return { status: 'covered', arrangement, approvalRequired, patient: { kind: 'per_unit', amountMinor: copayPerUnit(rule.copay, tariffMinor) } };
  if (arrangement === 'per_service') return { status: 'not_configured', missing: 'tariff' };
  // Capitation without a tariff: the co-pay can only be stated against the list price.
  if (rule.copay.kind === 'none') return { status: 'covered', arrangement, approvalRequired, patient: { kind: 'per_unit', amountMinor: 0 } };
  if (rule.copay.kind === 'percent') return { status: 'covered', arrangement, approvalRequired, patient: { kind: 'percent_of_list', basisPoints: rule.copay.basisPoints } };
  return { status: 'covered', arrangement, approvalRequired, patient: { kind: 'fixed_per_unit_capped_at_list', amountMinor: rule.copay.amountMinor } };
};

/** Every fee item the terms mention, so the schedule can carry an exact line for each. */
const mentionedItems = (terms: PayerContractTerms, plan: ContractPlan): string[] =>
  [...new Set([...Object.keys(terms.tariff), ...Object.keys(terms.arrangements.items), ...Object.keys(plan.rules.items)])].sort();

/**
 * The patient-facing lines for one plan. `categoryOf` names each mentioned fee
 * item's category; an item the hospital no longer has resolves to
 * `not_configured` rather than guessing its category.
 */
export const buildScheduleLines = (terms: PayerContractTerms, plan: ContractPlan, categoryOf: (feeItemId: string) => FeeCategory | undefined) => {
  const items: Record<string, ScheduleLine> = {};
  for (const feeItemId of mentionedItems(terms, plan)) {
    const category = categoryOf(feeItemId);
    items[feeItemId] = category ? scheduleLineFor(terms, plan, feeItemId, category) : { status: 'not_configured', missing: 'arrangement' };
  }
  const categories: Partial<Record<FeeCategory, ScheduleLine>> = {};
  for (const category of FeeCategory.options) categories[category] = scheduleLineFor(terms, plan, undefined, category);
  return { items, categories };
};

export type UnsupportedTerm = { scope: 'category' | 'item'; key: string; feature: string; planCode?: string };
/**
 * What activation must point out by name: every arrangement and every co-pay
 * basis calculation version 1 cannot calculate. Those services stay undetermined.
 */
export const unsupportedArrangements = (terms: PayerContractTerms): UnsupportedTerm[] => [
  ...Object.entries(terms.arrangements.categories).filter(([, a]) => a && !isSupportedArrangement(a)).map(([key, a]) => ({ scope: 'category' as const, key, feature: a as string })),
  ...Object.entries(terms.arrangements.items).filter(([, a]) => !isSupportedArrangement(a)).map(([key, a]) => ({ scope: 'item' as const, key, feature: a as string })),
  ...terms.plans.flatMap((plan) => [
    ...Object.entries(plan.rules.categories).flatMap(([key, rule]) => {
      const feature = rule?.coverage === 'covered' ? unsupportedCopay(rule.copay) : undefined;
      return feature ? [{ scope: 'category' as const, key, feature, planCode: plan.planCode }] : [];
    }),
    ...Object.entries(plan.rules.items).flatMap(([key, rule]) => {
      const feature = rule.coverage === 'covered' ? unsupportedCopay(rule.copay) : undefined;
      return feature ? [{ scope: 'item' as const, key, feature, planCode: plan.planCode }] : [];
    }),
  ]),
];

/** Full split of one charge. Every part is a whole minor unit and they sum to the list price. */
export type AllocationSplit = {
  arrangement: 'per_service' | 'capitation';
  patientShareMinor: number;
  /** An HMO receivable. Always 0 under capitation. */
  payerShareMinor: number;
  /** List price minus the tariff total. Negative when the tariff is above the list price. */
  contractAdjustmentMinor: number;
  /** Covered by capitation payments; never a per-visit receivable. */
  capitationCoveredMinor: number;
  tariffTotalMinor?: number;
};

export type ComputeResult =
  | { ok: true; split: AllocationSplit; rule: PlanRule; tariffUnitMinor?: number }
  | { ok: false; reason: UndeterminedReason; detail?: string };

/**
 * The server's full calculation from the confidential terms. It must give the
 * same patient share as `estimateCoverage` reading the schedule built from the
 * same terms — `scheduleAgrees` checks that at confirmation, and a property test
 * checks it over generated contracts.
 */
export const computeAllocation = (input: { terms: PayerContractTerms; planCode: string; charge: Pick<Charge, 'feeItemId' | 'category' | 'listPriceMinor' | 'currency'>; units: number | undefined }): ComputeResult => {
  const { terms, charge, units } = input;
  const plan = terms.plans.find((candidate) => candidate.planCode === input.planCode);
  if (!plan) return { ok: false, reason: 'not_configured', detail: 'plan' };
  if (charge.currency !== terms.currency) return { ok: false, reason: 'not_configured', detail: 'currency' };
  const { arrangement, rule, tariffMinor } = resolveTerms(terms, plan, charge.feeItemId, charge.category);
  if (rule?.coverage === 'excluded') return { ok: false, reason: rule.patientLiability === 'not_billable' ? 'not_billable_to_patient' : rule.patientLiability === 'patient_pays' ? 'excluded_patient_pays' : 'exclusion_liability_not_configured' };
  if (!arrangement) return { ok: false, reason: 'not_configured', detail: 'arrangement' };
  if (!isSupportedArrangement(arrangement)) return { ok: false, reason: 'unsupported_arrangement', detail: arrangement };
  if (!rule) return { ok: false, reason: 'not_configured', detail: 'rule' };
  if (!calculableCopay(rule.copay)) return { ok: false, reason: 'unsupported_arrangement', detail: unsupportedCopay(rule.copay) };
  if (units === undefined || !(units > 0)) return { ok: false, reason: 'quantity_unavailable' };
  const list = charge.listPriceMinor;
  if (tariffMinor !== undefined) {
    const tariffTotal = roundHalfUp(tariffMinor * units);
    const patient = roundHalfUp(copayPerUnit(rule.copay, tariffMinor) * units);
    const remainder = tariffTotal - patient;
    return { ok: true, rule, tariffUnitMinor: tariffMinor, split: {
      arrangement, patientShareMinor: patient, tariffTotalMinor: tariffTotal, contractAdjustmentMinor: list - tariffTotal,
      payerShareMinor: arrangement === 'per_service' ? remainder : 0,
      capitationCoveredMinor: arrangement === 'capitation' ? remainder : 0,
    } };
  }
  if (arrangement === 'per_service') return { ok: false, reason: 'not_configured', detail: 'tariff' };
  const line = scheduleLineFor(terms, plan, charge.feeItemId, charge.category);
  if (line.status !== 'covered') return { ok: false, reason: 'not_configured', detail: 'rule' };
  const patient = patientShareFor(line.patient, units, list);
  return { ok: true, rule, split: { arrangement, patientShareMinor: patient, payerShareMinor: 0, contractAdjustmentMinor: 0, capitationCoveredMinor: list - patient } };
};

/** Invariant of every split: the parts account for the list price exactly. */
export const splitBalances = (split: AllocationSplit, listPriceMinor: number): boolean =>
  [split.patientShareMinor, split.payerShareMinor, split.contractAdjustmentMinor, split.capitationCoveredMinor].every(Number.isInteger)
  && split.patientShareMinor >= 0 && split.payerShareMinor >= 0 && split.capitationCoveredMinor >= 0
  && (split.arrangement === 'per_service' ? split.capitationCoveredMinor === 0 : split.payerShareMinor === 0)
  && split.patientShareMinor + split.payerShareMinor + split.contractAdjustmentMinor + split.capitationCoveredMinor === listPriceMinor;

/* ------------------------------------------------------------------ */
/* Units and service dates                                             */
/* ------------------------------------------------------------------ */

/**
 * How many units a charge bills. Medicine supplies carry their quantity on the
 * dispense entry; every other charge in Geneus is one unit. When a supply's
 * entry is not available the quantity is unknown — not assumed to be one.
 */
export const chargeUnits = (charge: Pick<Charge, 'dispenseEntryId'>, dispenseEntry?: EncounterEntry): number | undefined => {
  if (!charge.dispenseEntryId) return 1;
  if (!dispenseEntry || dispenseEntry.id !== charge.dispenseEntryId) return undefined;
  const quantity = dispensingDetails(dispenseEntry)?.quantity;
  return quantity !== undefined && quantity > 0 ? quantity : undefined;
};

/**
 * The calendar date of service in the facility's time zone. Cover and checks
 * are dated by staff in local dates, so UTC would move late-night services to
 * the wrong day. Without a recorded time zone there is no insurance service
 * date: the caller gets `undefined`, never a UTC guess.
 */
const dateFormats = new Map<string, Intl.DateTimeFormat>();
export const serviceDateOf = (createdOn: string, timeZone: string | undefined): string | undefined => {
  if (!timeZone) return undefined;
  // Building a formatter is far costlier than using one; billing dates thousands of charges at a time.
  let format = dateFormats.get(timeZone);
  if (!format) { format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); dateFormats.set(timeZone, format); }
  return format.format(new Date(createdOn));
};

/* ------------------------------------------------------------------ */
/* Estimating one charge — the same on device and server              */
/* ------------------------------------------------------------------ */

export const UndeterminedReason = z.enum([
  'cover_not_checked', 'check_pending', 'not_eligible', 'choose_cover', 'not_configured',
  'unsupported_arrangement', 'quantity_unavailable', 'not_billable_to_patient', 'exclusion_liability_not_configured',
  'excluded_patient_pays', 'facility_timezone_missing', 'self_pay_not_permitted',
]);
export type UndeterminedReason = z.infer<typeof UndeterminedReason>;

export type CoverageEstimate =
  | { state: 'self_pay' }
  | { state: 'exempt' }
  | { state: 'finalised'; allocation: CoverageAllocation }
  | { state: 'self_pay_confirmed'; allocation: CoverageAllocation }
  | { state: 'self_pay_elected'; election: CoverageElection; cover: PatientCover }
  | { state: 'not_covered'; cover: PatientCover; check: CoverCheck; schedule: CoverSchedule }
  | { state: 'undetermined'; reason: UndeterminedReason; detail?: string; cover?: PatientCover; check?: CoverCheck; schedule?: CoverSchedule }
  | { state: 'estimated'; cover: PatientCover; check: CoverCheck; schedule: CoverSchedule; line: Extract<ScheduleLine, { status: 'covered' }>; units: number; patientShareMinor: number; election?: CoverageElection };

export type CoverageRecords = {
  covers: readonly PatientCover[];
  checks: readonly CoverCheck[];
  elections: readonly CoverageElection[];
  allocations: readonly CoverageAllocation[];
  schedules: readonly CoverSchedule[];
};

const byNewest = <T extends { createdOn: string; id: string }>(a: T, b: T) => b.createdOn.localeCompare(a.createdOn) || b.id.localeCompare(a.id);

/** The head of an insert-only chain: the record nothing supersedes. */
export const currentAllocation = (chargeId: string, allocations: readonly CoverageAllocation[]): CoverageAllocation | undefined => {
  const mine = allocations.filter((allocation) => allocation.chargeId === chargeId);
  const superseded = new Set(mine.map((allocation) => allocation.supersedes).filter(Boolean));
  return mine.filter((allocation) => !superseded.has(allocation.id)).sort(byNewest)[0];
};

/** Covers nothing has replaced, active and valid on the date. */
export const coversOn = (patientId: string, date: string, covers: readonly PatientCover[]): PatientCover[] => {
  const mine = covers.filter((cover) => cover.patientId === patientId);
  const replaced = new Set(mine.map((cover) => cover.replaces).filter(Boolean));
  return mine.filter((cover) => !replaced.has(cover.id) && cover.active && (!cover.validFrom || cover.validFrom <= date) && (!cover.validTo || date <= cover.validTo));
};

/** The schedule in force: the highest active version of the payer's contract that has started and not ended. */
export const scheduleOn = (payerId: string, plan: string, date: string, schedules: readonly CoverSchedule[]): CoverSchedule | undefined =>
  schedules
    .filter((s) => s.payerId === payerId && s.planCode === plan && s.effectiveFrom <= date && (!s.effectiveTo || date <= s.effectiveTo) && (!s.endedOn || date < s.endedOn))
    .sort((a, b) => b.contractVersion - a.contractVersion)[0];

/**
 * Whether a recorded self-pay choice is permitted on its date of service. A
 * "not eligible" choice rests on the cited check. A member's own choice rests on
 * the contract version in force that day: only `allowed` permits it.
 */
export const selfPayPermitted = (election: CoverageElection, cover: PatientCover, serviceDate: string, records: Pick<CoverageRecords, 'checks' | 'schedules'>): boolean => {
  if (election.reason === 'not_eligible') {
    const check = records.checks.find((c) => c.id === election.coverCheckId);
    return Boolean(check && check.coverId === cover.id && check.result === 'not_eligible' && check.coversFrom <= serviceDate && serviceDate <= check.coversTo);
  }
  return scheduleOn(cover.payerId, cover.planCode, serviceDate, records.schedules)?.selfPayElection === 'allowed';
};

/**
 * Resolves one charge, in a fixed order: exemption, confirmed snapshot,
 * election, cover, check, schedule, line. `undetermined` carries the first
 * missing fact, so whoever resolves it knows what to do.
 */
export const estimateCoverage = (input: {
  charge: Pick<Charge, 'id' | 'patientId' | 'feeItemId' | 'category' | 'listPriceMinor' | 'amountMinor' | 'currency' | 'createdOn' | 'dispenseEntryId'>;
  records: CoverageRecords;
  serviceDate: string | undefined;
  units: number | undefined;
  /**
   * Whether insurance billing is active for the hospital. While it is not
   * (setup, or after deactivation) cover never changes a bill — but a split
   * already confirmed stays: it is an obligation the hospital agreed.
   */
  billingActive: boolean;
}): CoverageEstimate => {
  const { charge, records } = input;
  if (charge.amountMinor === 0) return { state: 'exempt' };
  const confirmed = currentAllocation(charge.id, records.allocations);
  if (confirmed) return confirmed.state === 'finalised' ? { state: 'finalised', allocation: confirmed } : { state: 'self_pay_confirmed', allocation: confirmed };
  if (!input.billingActive) return { state: 'self_pay' };

  const allCovers = records.covers.filter((c) => c.patientId === charge.patientId);
  if (!input.serviceDate) return allCovers.length ? { state: 'undetermined', reason: 'facility_timezone_missing' } : { state: 'self_pay' };
  const serviceDate = input.serviceDate;
  const valid = coversOn(charge.patientId, serviceDate, records.covers);
  const elections = records.elections.filter((e) => e.patientId === charge.patientId && e.chargeIds.includes(charge.id)).sort(byNewest);
  const selfPay = elections.find((e) => e.kind === 'self_pay');
  if (selfPay) {
    const cover = allCovers.find((c) => c.id === selfPay.coverId);
    if (cover) {
      // A recorded choice always stays on record; it counts only while the rule in force on the date of service permits it.
      if (selfPayPermitted(selfPay, cover, serviceDate, records)) return { state: 'self_pay_elected', election: selfPay, cover };
      return { state: 'undetermined', reason: 'self_pay_not_permitted', cover };
    }
  }
  if (!valid.length) return { state: 'self_pay' };
  const chosen = elections.find((e) => e.kind === 'use_cover' && valid.some((c) => c.id === e.coverId));
  const cover = chosen ? valid.find((c) => c.id === chosen.coverId)! : valid.length === 1 ? valid[0] : undefined;
  if (!cover) return { state: 'undetermined', reason: 'choose_cover' };

  const check = records.checks.filter((c) => c.coverId === cover.id && c.patientId === charge.patientId && c.coversFrom <= serviceDate && serviceDate <= c.coversTo).sort(byNewest)[0];
  if (!check) return { state: 'undetermined', reason: 'cover_not_checked', cover };
  if (check.result === 'pending') return { state: 'undetermined', reason: 'check_pending', cover, check };
  if (check.result === 'not_eligible') return { state: 'undetermined', reason: 'not_eligible', cover, check };

  const schedule = scheduleOn(cover.payerId, cover.planCode, serviceDate, records.schedules);
  if (!schedule) return { state: 'undetermined', reason: 'not_configured', detail: 'contract', cover, check };
  if (schedule.currency !== charge.currency) return { state: 'undetermined', reason: 'not_configured', detail: 'currency', cover, check, schedule };
  const line = schedule.items[charge.feeItemId] ?? schedule.categories[charge.category];
  if (!line) return { state: 'undetermined', reason: 'not_configured', detail: 'rule', cover, check, schedule };
  if (line.status === 'not_configured') return { state: 'undetermined', reason: 'not_configured', detail: line.missing, cover, check, schedule };
  if (line.status === 'unsupported') return { state: 'undetermined', reason: 'unsupported_arrangement', detail: line.feature, cover, check, schedule };
  if (line.status === 'excluded') {
    if (line.patientLiability === 'patient_pays') return { state: 'not_covered', cover, check, schedule };
    return { state: 'undetermined', reason: line.patientLiability === 'not_billable' ? 'not_billable_to_patient' : 'exclusion_liability_not_configured', cover, check, schedule };
  }
  if (input.units === undefined || !(input.units > 0)) return { state: 'undetermined', reason: 'quantity_unavailable', cover, check, schedule };
  return { state: 'estimated', cover, check, schedule, line, units: input.units, patientShareMinor: patientShareFor(line.patient, input.units, charge.listPriceMinor), ...(chosen ? { election: chosen } : {}) };
};

/**
 * What the patient is responsible for on one charge, before discounts,
 * waivers, payments and refunds. `undeterminedMinor` is shown separately and
 * never added to what is due. `final` is true only when no later decision can
 * change the figure — the condition for refunding a credit.
 */
export const patientResponsibility = (charge: Pick<Charge, 'amountMinor'>, estimate: CoverageEstimate): { baseMinor: number; undeterminedMinor: number; estimated: boolean; final: boolean } => {
  switch (estimate.state) {
    case 'self_pay': case 'self_pay_elected': case 'not_covered':
      return { baseMinor: charge.amountMinor, undeterminedMinor: 0, estimated: false, final: true };
    case 'self_pay_confirmed':
      return { baseMinor: charge.amountMinor, undeterminedMinor: 0, estimated: false, final: true };
    case 'exempt':
      return { baseMinor: 0, undeterminedMinor: 0, estimated: false, final: true };
    case 'finalised':
      return { baseMinor: estimate.allocation.patientShareMinor, undeterminedMinor: 0, estimated: false, final: true };
    case 'estimated':
      return { baseMinor: estimate.patientShareMinor, undeterminedMinor: 0, estimated: true, final: false };
    case 'undetermined':
      return { baseMinor: 0, undeterminedMinor: charge.amountMinor, estimated: false, final: false };
  }
};

/**
 * A routine visit can be confirmed in bulk. Everything else — elections,
 * approvals, overpayments, anything undetermined — needs individual review.
 */
export const isRoutine = (estimate: CoverageEstimate, paidMinor: number): boolean =>
  estimate.state === 'estimated' && !estimate.election && !estimate.line.approvalRequired && paidMinor <= estimate.patientShareMinor;

/**
 * Groups coverage records by patient once, so estimating many charges costs
 * one pass over the records plus one small lookup per charge — never every
 * record for every charge. Schedules are shared by all patients.
 */
export const indexCoverageRecords = (records: CoverageRecords): ((patientId: string) => CoverageRecords) => {
  const group = <T extends { patientId: string }>(items: readonly T[]) => {
    const map = new Map<string, T[]>();
    for (const item of items) { const list = map.get(item.patientId); if (list) list.push(item); else map.set(item.patientId, [item]); }
    return map;
  };
  const covers = group(records.covers), checks = group(records.checks), elections = group(records.elections), allocations = group(records.allocations);
  const empty: never[] = [];
  const cache = new Map<string, CoverageRecords>();
  return (patientId) => {
    let found = cache.get(patientId);
    if (!found) {
      found = { covers: covers.get(patientId) ?? empty, checks: checks.get(patientId) ?? empty, elections: elections.get(patientId) ?? empty, allocations: allocations.get(patientId) ?? empty, schedules: records.schedules };
      cache.set(patientId, found);
    }
    return found;
  };
};

/* ------------------------------------------------------------------ */
/* Supporting documents and submission settings — server-held          */
/* ------------------------------------------------------------------ */

/**
 * Evidence a hospital keeps for a payer. Optional: a contract can be set up by
 * hand without any of them. A document is evidence, never configuration.
 */
export const InsuranceDocumentType = z.enum([
  'contract', 'tariff_schedule', 'benefit_schedule', 'authorization_policy', 'claim_template',
  'referral_form', 'remittance_advice', 'enrollee_roster', 'other',
  // Claim evidence (Milestone 3): kept with the payer, attached to claims only by a person's choice.
  'authorization_evidence', 'referral_letter', 'submission_evidence', 'acknowledgement',
]);
export type InsuranceDocumentType = z.infer<typeof InsuranceDocumentType>;
export const DocumentVerification = z.enum(['unverified', 'verified', 'rejected']);

/** The metadata staff send with an upload; the server adds identity, version and checksums. */
export const InsuranceDocumentUpload = z.strictObject({
  payerId: z.string().min(1),
  documentType: InsuranceDocumentType,
  title: text.max(200),
  fileName: text.max(200),
  /** A new version of an earlier document of the same payer and type. */
  replaces: z.string().min(1).optional(),
  effectiveFrom: isoDate.optional(),
  notes: text.max(2000).optional(),
});
export type InsuranceDocumentUpload = z.infer<typeof InsuranceDocumentUpload>;

export const InsuranceDocument = InsuranceDocumentUpload.extend({
  id: z.string().min(1),
  mimeType: z.string().min(1),
  byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(),
  verification: DocumentVerification,
  verifiedBy: z.string().min(1).optional(),
  verifiedOn: z.string().min(1).optional(),
  verificationNote: text.max(1000).optional(),
  uploadedBy: z.string().min(1),
  uploadedOn: z.string().min(1),
});
export type InsuranceDocument = z.infer<typeof InsuranceDocument>;

/** How a payer's claims leave the hospital. Only manual submission exists today. */
export const SubmissionMethod = z.enum(['manual', 'direct']);
export const SubmissionChannel = z.enum(['portal', 'email', 'physical', 'other']);
export const ClaimFormat = z.enum(['csv', 'xlsx', 'pdf']);
export const SubmissionProfile = z.strictObject({
  method: SubmissionMethod,
  channel: SubmissionChannel,
  portalUrl: z.url().max(500).optional(),
  recipient: text.max(200).optional(),
  instructions: text.max(2000).optional(),
  /** Days after the service by which claims must reach the payer — as the contract states it, never defaulted. */
  deadlineDays: z.number().int().positive().max(730).optional(),
  claimFormat: ClaimFormat.optional(),
  requiredAttachments: z.array(InsuranceDocumentType.or(text.max(100))).max(20).default([]),
  /**
   * What diagnosis this payer's claims need. `coded_icd10` (the default) never passes until a verified
   * ICD-10 catalogue is in place; `free_text` only where the payer has said it accepts written diagnoses.
   */
  diagnosisRequirement: z.enum(['coded_icd10', 'free_text', 'not_required']).default('coded_icd10'),
  /** Every claim needs a recorded, approved referral for the patient. */
  referralRequired: z.boolean().default(false),
}).superRefine((profile, context) => {
  if (profile.channel === 'portal' && !profile.portalUrl) context.addIssue({ code: 'custom', path: ['portalUrl'], message: 'Give the portal address' });
  if (profile.channel === 'email' && !profile.recipient) context.addIssue({ code: 'custom', path: ['recipient'], message: 'Give the approved claims email address' });
});
export type SubmissionProfile = z.infer<typeof SubmissionProfile>;
export const StoredSubmissionProfile = z.strictObject({ payerId: z.string().min(1), profile: SubmissionProfile, revision: z.number().int().positive(), updatedBy: z.string().min(1), updatedOn: z.string().min(1) });
export type StoredSubmissionProfile = z.infer<typeof StoredSubmissionProfile>;

/** What a hospital still needs before insurance billing can be switched on, as the server sees it. */
export type InsuranceSetupItem = { kind: string; ok: boolean; detail?: string; requiredFor: 'billing' | 'claims' | 'optional' };
export type InsuranceSetupStatus = { state: InsuranceState; timeZone?: string; items: InsuranceSetupItem[] };

/* ------------------------------------------------------------------ */
/* Spreadsheet import (Milestone 2)                                    */
/* ------------------------------------------------------------------ */

/**
 * What a saved column mapping imports. Mapping is generic: each kind names its
 * own fields, and a template remembers which column held each field for a
 * given sheet layout, so the next file in the same layout maps itself.
 */
export const ImportKind = z.enum(['contract_tariff']);
export type ImportKind = z.infer<typeof ImportKind>;
export const IMPORT_LIMITS = { maxFileBytes: 5 * 1024 * 1024, maxRows: 5000, maxColumns: 60, maxCellChars: 1000, maxSheets: 30 } as const;

const headerCell = z.string().max(200);
export const ImportTemplateSave = z.strictObject({
  kind: ImportKind,
  payerId: z.string().min(1).optional(),
  name: text.max(120),
  /** The header row's cells, normalised, so a later file in the same layout is recognised. */
  headers: z.array(headerCell).max(IMPORT_LIMITS.maxColumns),
  headerRow: z.number().int().min(0).max(50),
  /** Field key → zero-based column index. */
  mapping: z.record(z.string().min(1).max(60), z.number().int().min(0).max(IMPORT_LIMITS.maxColumns - 1)),
  expectedRevision: z.number().int().positive().optional(),
});
export type ImportTemplateSave = z.infer<typeof ImportTemplateSave>;
export const ImportTemplate = ImportTemplateSave.omit({ expectedRevision: true }).extend({
  id: z.string().min(1), revision: z.number().int().positive(), updatedBy: z.string().min(1), updatedOn: z.string().min(1),
});
export type ImportTemplate = z.infer<typeof ImportTemplate>;

/** Starts with a character a spreadsheet would treat as a formula. Such text is refused as a code. */
export const formulaLike = (value: string) => /^[=+@\t\r]/.test(value);

/** One priced service from an HMO tariff sheet, already matched to a fee item and confirmed by a person. */
export const TariffImportLine = z.strictObject({
  feeItemId: z.string().min(1).max(200),
  unitMinor: z.number().int().nonnegative().max(100_000_000_000),
  payerCode: z.string().trim().min(1).max(60).refine((v) => !formulaLike(v), 'A payer code cannot start with =, +, @ or a control character').optional(),
  /** The 1-based row in the file, for the audit trail and error messages. */
  sourceRow: z.number().int().positive(),
});
export type TariffImportLine = z.infer<typeof TariffImportLine>;

/**
 * Applies confirmed tariff lines to the payer's draft contract. `merge` keeps
 * prices the sheet does not mention; `replace` makes the sheet the whole
 * tariff. The original file is not sent or kept: only its name and checksum.
 */
export const TariffImport = z.strictObject({
  payerId: z.string().min(1),
  requestKey: z.string().min(8).max(100),
  expectedRevision: z.number().int().positive().optional(),
  mode: z.enum(['merge', 'replace']),
  lines: z.array(TariffImportLine).min(1).max(IMPORT_LIMITS.maxRows),
  source: z.strictObject({
    fileName: z.string().trim().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sheet: z.string().max(100).optional(),
    rows: z.number().int().nonnegative().max(IMPORT_LIMITS.maxRows),
    templateId: z.string().min(1).optional(),
  }),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, line] of value.lines.entries()) {
    if (seen.has(line.feeItemId)) context.addIssue({ code: 'custom', path: ['lines', index, 'feeItemId'], message: `Row ${line.sourceRow} prices a service already priced by an earlier row` });
    seen.add(line.feeItemId);
  }
});
export type TariffImport = z.infer<typeof TariffImport>;
/** `payloadSha256` is the server's own checksum of the validated rows it applied; the file checksum in the request is only what the browser reported. */
export type TariffImportResult = { contractVersionId: string; version: number; revision: number; added: number; changed: number; unchanged: number; removed: number; payloadSha256?: string };

/* ------------------------------------------------------------------ */
/* Billing periods (activation effective dates)                        */
/* ------------------------------------------------------------------ */

/**
 * A span during which insurance billing was active. A charge is judged
 * against cover only when it was raised inside one, whatever the hospital's
 * state now: activation never reclassifies earlier cash charges, and turning
 * billing off never strips cover from charges raised while it was on.
 */
export const InsuranceBillingPeriod = z.strictObject({ from: z.string().min(1), to: z.string().min(1).optional() });
export type InsuranceBillingPeriod = z.infer<typeof InsuranceBillingPeriod>;
export const inBillingPeriod = (at: string, periods: readonly InsuranceBillingPeriod[]): boolean => {
  const t = Date.parse(at);
  return Number.isFinite(t) && periods.some((p) => Date.parse(p.from) <= t && (!p.to || t < Date.parse(p.to)));
};
