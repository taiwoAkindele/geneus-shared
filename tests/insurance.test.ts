import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Charge, CoverCheck, CoverSchedule, CoverageAllocation, CoverageElection, EncounterEntry, PatientCover, PayerContractTerms, ROLE_PERMISSIONS, Refund, UploadRequest,
  buildScheduleLines, chargeUnits, computeAllocation, estimateCoverage, isRoutine, patientResponsibility, patientShareFor, percentOf,
  scheduleLineFor, serviceDateOf, splitBalances, unsupportedArrangements,
  type CoverageRecords, type FeeCategory, type PlanRule, type Arrangement,
} from '../src/index.ts';

// Synthetic payers and prices only: nothing here describes a real contract.
const base = { facilityId: 'TEST', deviceId: 'device:one', schemaVersion: 5, createdBy: 'staff:one' };
const at = (day: string) => `${day}T10:00:00.000Z`;
const PATIENT = 'TEST-000001-K2';

const terms = (overrides: Partial<PayerContractTerms> = {}): PayerContractTerms => PayerContractTerms.parse({
  payerId: 'payer:synthetic-a', effectiveFrom: '2026-01-01', currency: 'NGN',
  arrangements: { categories: { consultation: 'per_service', laboratory: 'per_service', registration: 'capitation', procedure: 'per_diem', other: 'per_service' }, items: { 'fee:pkg': 'package' } },
  tariff: { 'fee:consult': { unitMinor: 4_000 }, 'fee:fbc': { unitMinor: 2_505 }, 'fee:drug': { unitMinor: 333 }, 'fee:capt': { unitMinor: 1_000 } },
  plans: [{ planCode: 'GOLD', name: 'Synthetic gold', rules: {
    categories: { consultation: { coverage: 'covered', copay: { kind: 'percent', basisPoints: 1_000 } }, laboratory: { coverage: 'covered', copay: { kind: 'percent', basisPoints: 1_000 } },
      registration: { coverage: 'covered', copay: { kind: 'none' } }, other: { coverage: 'covered', copay: { kind: 'fixed', amountMinor: 50, basis: 'per_unit' } }, procedure: { coverage: 'covered', copay: { kind: 'none' } } },
    items: { 'fee:cosmetic': { coverage: 'excluded', patientLiability: 'patient_pays' }, 'fee:nobill': { coverage: 'excluded', patientLiability: 'not_billable' }, 'fee:unknownliab': { coverage: 'excluded' }, 'fee:mri': { coverage: 'covered', copay: { kind: 'none' }, approvalRequired: true } },
  } }],
  ...overrides,
});

const CATEGORY: Record<string, FeeCategory> = { 'fee:consult': 'consultation', 'fee:fbc': 'laboratory', 'fee:drug': 'other', 'fee:capt': 'registration', 'fee:cosmetic': 'procedure', 'fee:nobill': 'procedure', 'fee:unknownliab': 'procedure', 'fee:mri': 'laboratory', 'fee:pkg': 'procedure', 'fee:card': 'card', 'fee:x': 'consultation' };

const schedule = (t: PayerContractTerms, version = 1, effectiveFrom = t.effectiveFrom): CoverSchedule => CoverSchedule.parse({
  ...base, id: `cover_schedule:v${version}`, type: 'cover_schedule', createdOn: at('2026-01-01'), payerId: t.payerId, contractId: 'contract:payer:synthetic-a',
  contractVersionId: `contract:payer:synthetic-a:v${version}`, contractVersion: version, planCode: 'GOLD', planName: 'Synthetic gold', currency: t.currency,
  effectiveFrom, effectiveTo: t.effectiveTo, selfPayElection: t.selfPayElection, calculationVersion: 1, ...buildScheduleLines(t, t.plans[0], (id) => CATEGORY[id]),
});
const charge = (feeItemId: string, listPriceMinor: number, extra: Partial<Charge> = {}): Charge => Charge.parse({
  ...base, type: 'charge', id: `charge:${feeItemId}:${listPriceMinor}`, createdOn: at('2026-03-10'), patientId: PATIENT, feeItemId, description: 'Synthetic service',
  category: CATEGORY[feeItemId] ?? 'consultation', listPriceMinor, amountMinor: extra.exemptionReason ? 0 : listPriceMinor, currency: 'NGN', ...extra,
});
const cover = (extra: Partial<PatientCover> = {}) => PatientCover.parse({ ...base, type: 'patient_cover', id: 'cover:one', createdOn: at('2026-02-01'), patientId: PATIENT, payerId: 'payer:synthetic-a', planCode: 'GOLD', enrolleeNumber: 'SYN-001', relationship: 'principal', active: true, ...extra });
const check = (result: CoverCheck['result'], extra: Partial<CoverCheck> = {}) => CoverCheck.parse({ ...base, type: 'cover_check', id: `check:${result}`, createdOn: at('2026-03-10'), patientId: PATIENT, coverId: 'cover:one', method: 'portal', result, coversFrom: '2026-03-10', coversTo: '2026-03-10', ...extra });
const records = (extra: Partial<CoverageRecords> = {}): CoverageRecords => ({ covers: [cover()], checks: [check('verified')], elections: [], allocations: [], schedules: [schedule(terms())], ...extra });
const estimate = (c: Charge, r: CoverageRecords = records(), units: number | undefined = 1) => estimateCoverage({ billingActive: true, charge: c, records: r, serviceDate: '2026-03-10', units });

describe('estimating one charge resolves every state explicitly', () => {
  it('a patient with no cover is billed exactly as today', () => {
    const c = charge('fee:consult', 5_000);
    const e = estimate(c, records({ covers: [] }));
    assert.equal(e.state, 'self_pay');
    assert.deepEqual(patientResponsibility(c, e), { baseMinor: 5_000, undeterminedMinor: 0, estimated: false, final: true });
  });
  it('an exempt charge stays exempt', () => assert.equal(estimate(charge('fee:consult', 5_000, { exemptionReason: 'Synthetic exemption' })).state, 'exempt'));
  it('unchecked, pending and not-eligible cover leave responsibility undetermined, never zero or full', () => {
    const c = charge('fee:consult', 5_000);
    for (const [checks, reason] of [[[], 'cover_not_checked'], [[check('pending')], 'check_pending'], [[check('not_eligible')], 'not_eligible']] as const) {
      const e = estimate(c, records({ checks: [...checks] }));
      assert.equal(e.state, 'undetermined'); assert.equal(e.state === 'undetermined' && e.reason, reason);
      assert.deepEqual(patientResponsibility(c, e), { baseMinor: 0, undeterminedMinor: 5_000, estimated: false, final: false });
    }
  });
  it('a check for another day does not count', () => assert.equal(estimate(charge('fee:consult', 5_000), records({ checks: [check('verified', { coversFrom: '2026-03-09', coversTo: '2026-03-09' })] })).state, 'undetermined'));
  it('two valid covers need a recorded choice', () => {
    const second = cover({ id: 'cover:two', enrolleeNumber: 'SYN-002' });
    const c = charge('fee:consult', 5_000);
    const e = estimate(c, records({ covers: [cover(), second] }));
    assert.equal(e.state === 'undetermined' && e.reason, 'choose_cover');
    const choice = CoverageElection.parse({ ...base, type: 'coverage_election', id: 'el:one', createdOn: at('2026-03-10'), patientId: PATIENT, kind: 'use_cover', coverId: 'cover:one', chargeIds: [c.id] });
    assert.equal(estimate(c, records({ covers: [cover(), second], elections: [choice] })).state, 'estimated');
  });
  it('per-service cover with a 10% co-pay: the patient owes the co-pay of the tariff', () => {
    const c = charge('fee:consult', 5_000);
    const e = estimate(c);
    assert.equal(e.state, 'estimated');
    assert.equal(e.state === 'estimated' && e.patientShareMinor, 400);
    assert.deepEqual(patientResponsibility(c, e), { baseMinor: 400, undeterminedMinor: 0, estimated: true, final: false });
  });
  it('an excluded service bills the patient only when the contract says so', () => {
    assert.equal(estimate(charge('fee:cosmetic', 9_000)).state, 'not_covered');
    const nobill = estimate(charge('fee:nobill', 9_000));
    assert.equal(nobill.state === 'undetermined' && nobill.reason, 'not_billable_to_patient');
    const unknown = estimate(charge('fee:unknownliab', 9_000));
    assert.equal(unknown.state === 'undetermined' && unknown.reason, 'exclusion_liability_not_configured');
  });
  it('a missing tariff, rule or contract is named, never defaulted', () => {
    const noTariff = estimate(charge('fee:mri-unpriced', 7_000, { category: 'laboratory' }));
    assert.equal(noTariff.state === 'undetermined' && noTariff.detail, 'tariff');
    const noRule = estimate(charge('fee:card', 500));
    assert.equal(noRule.state === 'undetermined' && noRule.detail, 'arrangement');
    const noContract = estimate(charge('fee:consult', 5_000), records({ schedules: [] }));
    assert.equal(noContract.state === 'undetermined' && noContract.detail, 'contract');
    const otherCurrency = estimate(charge('fee:consult', 5_000, { currency: 'USD' }));
    assert.equal(otherCurrency.state === 'undetermined' && otherCurrency.detail, 'currency');
  });
  it('per diem and package arrangements never produce money', () => {
    for (const fee of ['fee:pkg', 'fee:cosmetic-proc']) {
      const e = estimate(charge(fee, 20_000, { category: 'procedure' }));
      if (fee === 'fee:pkg') assert.equal(e.state === 'undetermined' && e.reason, 'unsupported_arrangement');
    }
    const r = computeAllocation({ terms: terms(), planCode: 'GOLD', charge: charge('fee:pkg', 20_000, { category: 'procedure' }), units: 1 });
    assert.equal(r.ok, false);
    assert.deepEqual(unsupportedArrangements(terms()).map((u) => u.key).sort(), ['fee:pkg', 'procedure']);
  });
  it('an unknown quantity is undetermined, not one unit', () => {
    const c = charge('fee:drug', 1_000, { dispenseEntryId: 'rx:missing' });
    const e = estimateCoverage({ billingActive: true, charge: c, records: records(), serviceDate: '2026-03-10', units: chargeUnits(c) });
    assert.equal(e.state === 'undetermined' && e.reason, 'quantity_unavailable');
  });
  it('a confirmed snapshot wins over a later estimate, and a recorded self-pay over cover', () => {
    const c = charge('fee:consult', 5_000);
    const snapshot = CoverageAllocation.parse({ ...base, type: 'coverage_allocation', id: 'alloc:one', createdOn: at('2026-03-11'), patientId: PATIENT, chargeId: c.id, state: 'finalised', payerId: 'payer:synthetic-a', arrangement: 'per_service', patientShareMinor: 400, currency: 'NGN', basis: 'visit' });
    assert.equal(estimate(c, records({ allocations: [snapshot], schedules: [] })).state, 'finalised');
    const selfPay = CoverageElection.parse({ ...base, type: 'coverage_election', id: 'el:sp', createdOn: at('2026-03-10'), patientId: PATIENT, kind: 'self_pay', coverId: 'cover:one', chargeIds: [c.id], reason: 'patient_choice', patientAgreed: true });
    const e = estimate(c, records({ elections: [selfPay], schedules: [schedule(terms({ selfPayElection: 'allowed' }))] }));
    assert.equal(e.state, 'self_pay_elected', 'counts where the contract allows it');
    assert.equal(patientResponsibility(c, e).baseMinor, 5_000);
  });
  it('approvals and elections are never routine', () => {
    const mri = estimate(charge('fee:mri', 7_000, { category: 'laboratory' }), records({ schedules: [schedule(terms({ tariff: { ...terms().tariff, 'fee:mri': { unitMinor: 6_000 } } }))] }));
    assert.equal(mri.state, 'estimated');
    assert.equal(isRoutine(mri, 0), false);
    const plain = estimate(charge('fee:consult', 5_000));
    assert.equal(isRoutine(plain, 400), true);
    assert.equal(isRoutine(plain, 401), false, 'an overpayment needs review');
  });
});

describe('calculation version 1 arithmetic', () => {
  it('rounds half up in integer arithmetic', () => {
    assert.equal(percentOf(2_505, 1_000), 251);
    assert.equal(percentOf(2_504, 1_000), 250);
    assert.equal(percentOf(5, 1_000), 1);
  });
  it('splits a per-service charge into parts that sum to the list price, with a negative adjustment when the tariff is higher', () => {
    const r = computeAllocation({ terms: terms(), planCode: 'GOLD', charge: charge('fee:consult', 3_000), units: 1 });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.split, { arrangement: 'per_service', patientShareMinor: 400, payerShareMinor: 3_600, contractAdjustmentMinor: -1_000, capitationCoveredMinor: 0, tariffTotalMinor: 4_000 });
    assert.ok(splitBalances(r.split, 3_000));
  });
  it('capitation is never a receivable', () => {
    const r = computeAllocation({ terms: terms(), planCode: 'GOLD', charge: charge('fee:capt', 1_500, { category: 'registration' }), units: 1 });
    assert.ok(r.ok && r.split.payerShareMinor === 0 && r.split.capitationCoveredMinor === 1_000 && r.split.contractAdjustmentMinor === 500);
    const untariffed = computeAllocation({ terms: terms(), planCode: 'GOLD', charge: charge('fee:reg-other', 800, { category: 'registration' }), units: 1 });
    assert.ok(untariffed.ok && untariffed.split.payerShareMinor === 0 && untariffed.split.capitationCoveredMinor === 800 && untariffed.split.contractAdjustmentMinor === 0);
  });
  it('quantities use the per-unit co-pay times the units, rounded half up, the same as the medicine price', () => {
    const r = computeAllocation({ terms: terms(), planCode: 'GOLD', charge: charge('fee:drug', 1_000), units: 2.5 });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.split.tariffTotalMinor, 833); // round(333 × 2.5)
    assert.equal(r.split.patientShareMinor, 125); // round(50 × 2.5)
    assert.ok(splitBalances(r.split, 1_000));
  });
  it('chooses the contract version in force on the date of service', () => {
    const v2 = terms({ effectiveFrom: '2026-03-15', tariff: { ...terms().tariff, 'fee:consult': { unitMinor: 5_000 } } });
    const r = records({ schedules: [schedule(terms(), 1), schedule(v2, 2)] });
    const before = estimateCoverage({ billingActive: true, charge: charge('fee:consult', 5_000), records: r, serviceDate: '2026-03-10', units: 1 });
    const after = estimateCoverage({ billingActive: true, charge: charge('fee:consult', 5_000), records: { ...r, checks: [check('verified', { coversFrom: '2026-03-20', coversTo: '2026-03-20' })] }, serviceDate: '2026-03-20', units: 1 });
    assert.equal(before.state === 'estimated' && before.patientShareMinor, 400);
    assert.equal(after.state === 'estimated' && after.patientShareMinor, 500);
  });
  it('an item rule wins over its category rule', () => {
    const line = scheduleLineFor(terms(), terms().plans[0], 'fee:cosmetic', 'procedure');
    assert.equal(line.status, 'excluded');
  });
  it('dates services in the facility time zone', () => {
    assert.equal(serviceDateOf('2026-03-09T23:30:00.000Z', 'Africa/Lagos'), '2026-03-10');
    assert.equal(serviceDateOf('2026-03-09T23:30:00.000Z', undefined), undefined, 'no time zone, no insurance date — never a UTC guess');
  });
  it('reads a medicine supply quantity from its dispense entry', () => {
    const entry = { id: 'rx:one', values: {} } as unknown as EncounterEntry;
    assert.equal(chargeUnits({ dispenseEntryId: undefined }), 1);
    assert.equal(chargeUnits({ dispenseEntryId: 'rx:one' }, entry), undefined, 'no recorded quantity is not one unit');
  });
});

describe('the offline schedule reproduces the full calculation exactly', () => {
  // Deterministic generator: the same contracts every run.
  let seed = 20_261_112;
  const next = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
  const pick = <T>(xs: readonly T[]) => xs[next(xs.length)];
  const arrangements: Arrangement[] = ['per_service', 'capitation', 'per_diem', 'package'];

  it('agrees on the patient share for 2,000 generated contracts and charges', () => {
    let compared = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const copay = pick([{ kind: 'none' }, { kind: 'percent', basisPoints: next(10_001) }, { kind: 'fixed', amountMinor: next(20_000), basis: 'per_unit' }, { kind: 'fixed', amountMinor: next(20_000), basis: pick(['per_charge', 'per_dispense', 'per_visit', 'per_claim'] as const) }] as const);
      const rule: PlanRule = next(5) === 0 ? { coverage: 'excluded', patientLiability: pick(['patient_pays', 'not_billable', undefined] as const) } as PlanRule : { coverage: 'covered', copay, approvalRequired: false };
      const withTariff = next(3) !== 0;
      const t = PayerContractTerms.parse({
        payerId: 'payer:synthetic-a', effectiveFrom: '2026-01-01', currency: 'NGN',
        arrangements: { categories: { consultation: pick(arrangements) }, items: {} },
        tariff: withTariff ? { 'fee:x': { unitMinor: next(50_000) } } : {},
        plans: [{ planCode: 'GOLD', name: 'Synthetic', rules: { categories: { consultation: rule }, items: {} } }],
      });
      const list = 1 + next(60_000);
      const units = pick([1, 1, 2, 3, 0.5, 2.5, 7.25]);
      const c = charge('fee:x', list, { category: 'consultation', id: `charge:gen:${i}` });
      const e = estimateCoverage({ billingActive: true, charge: c, records: records({ schedules: [schedule(t)] }), serviceDate: '2026-03-10', units });
      const full = computeAllocation({ terms: t, planCode: 'GOLD', charge: c, units });
      if (e.state === 'estimated') {
        assert.ok(full.ok, `full calculation must succeed when the schedule estimates (case ${i})`);
        if (!full.ok) continue;
        assert.equal(e.patientShareMinor, full.split.patientShareMinor, `case ${i}`);
        assert.ok(splitBalances(full.split, list), `case ${i} balances`);
        compared += 1;
      } else {
        assert.equal(full.ok, false, `the schedule must not hide a calculable charge (case ${i}: ${e.state})`);
      }
    }
    assert.ok(compared > 500, `compared ${compared} estimated charges`);
  });

  it('never sends a tariff or payer share in the schedule', () => {
    const json = JSON.stringify(schedule(terms()));
    assert.ok(!json.includes('4000') && !json.includes('unitMinor') && !json.includes('payer_share') && !json.includes('basisPoints":1000'));
    assert.equal(patientShareFor({ kind: 'per_unit', amountMinor: 400 }, 1, 5_000), 400);
  });
});

describe('terms version 1 cannot calculate stay explicit', () => {
  const withCopay = (copay: PlanRule) => terms({ plans: [{ planCode: 'GOLD', name: 'Synthetic gold', rules: { categories: { consultation: copay }, items: {} } }] });
  it('calculates a fixed co-pay only when the contract says it is per unit', () => {
    const perUnit = withCopay({ coverage: 'covered', copay: { kind: 'fixed', amountMinor: 300, basis: 'per_unit' }, approvalRequired: false });
    const r = computeAllocation({ terms: perUnit, planCode: 'GOLD', charge: charge('fee:consult', 5_000), units: 2 });
    assert.ok(r.ok && r.split.patientShareMinor === 600);
    for (const basis of ['per_charge', 'per_dispense', 'per_visit', 'per_claim'] as const) {
      const t = withCopay({ coverage: 'covered', copay: { kind: 'fixed', amountMinor: 300, basis }, approvalRequired: false });
      const e = estimate(charge('fee:consult', 5_000), records({ schedules: [schedule(t)] }));
      assert.equal(e.state === 'undetermined' && e.reason, 'unsupported_arrangement', basis);
      assert.equal(e.state === 'undetermined' && e.detail, `copay_${basis}`);
      assert.equal(computeAllocation({ terms: t, planCode: 'GOLD', charge: charge('fee:consult', 5_000), units: 1 }).ok, false, basis);
      assert.ok(unsupportedArrangements(t).some((u) => u.feature === `copay_${basis}` && u.planCode === 'GOLD'), 'activation names the unsupported co-pay');
    }
  });
  it('leaves insured charges undetermined when the hospital has no time zone', () => {
    const e = estimateCoverage({ billingActive: true, charge: charge('fee:consult', 5_000), records: records(), serviceDate: undefined, units: 1 });
    assert.equal(e.state === 'undetermined' && e.reason, 'facility_timezone_missing');
    assert.equal(estimateCoverage({ billingActive: true, charge: charge('fee:consult', 5_000), records: records({ covers: [] }), serviceDate: undefined, units: 1 }).state, 'self_pay', 'a cash patient is unaffected');
    // Setup mode: verified cover is recorded, but no bill changes until insurance billing is active.
    assert.equal(estimateCoverage({ billingActive: false, charge: charge('fee:consult', 5_000), records: records(), serviceDate: '2026-03-10', units: 1 }).state, 'self_pay', 'setup never changes a bill');
  });
  it('stops a schedule from its end date, without touching earlier services', () => {
    const ended = { ...schedule(terms()), endedOn: '2026-03-10' };
    assert.equal(estimate(charge('fee:consult', 5_000), records({ schedules: [ended] })).state, 'undetermined', 'the end date itself is no longer covered');
    const before = estimateCoverage({ billingActive: true, charge: charge('fee:consult', 5_000), records: { ...records({ schedules: [ended] }), checks: [check('verified', { coversFrom: '2026-03-09', coversTo: '2026-03-09' })] }, serviceDate: '2026-03-09', units: 1 });
    assert.equal(before.state, 'estimated');
  });
  it('judges a recorded self-pay choice by the contract version in force on the date of service', () => {
    const c = charge('fee:consult', 5_000);
    const choice = CoverageElection.parse({ ...base, type: 'coverage_election', id: 'el:choice', createdOn: at('2026-03-10'), patientId: PATIENT, kind: 'self_pay', coverId: 'cover:one', chargeIds: [c.id], reason: 'patient_choice', patientAgreed: true });
    const allowedV1 = schedule(terms({ selfPayElection: 'allowed' }), 1);
    const prohibitedV2 = schedule(terms({ selfPayElection: 'not_allowed', effectiveFrom: '2026-03-15' }), 2, '2026-03-15');
    const r = records({ elections: [choice], schedules: [allowedV1, prohibitedV2] });
    assert.equal(estimate(c, r).state, 'self_pay_elected', 'allowed on the 10th under version 1');
    const later = estimateCoverage({ billingActive: true, charge: c, records: r, serviceDate: '2026-03-20', units: 1 });
    assert.equal(later.state === 'undetermined' && later.reason, 'self_pay_not_permitted', 'the same choice is not honoured where version 2 prohibits it');
    assert.equal(r.elections.length, 1, 'the choice itself stays on record');
    const unset = estimate(c, records({ elections: [choice] }));
    assert.equal(unset.state === 'undetermined' && unset.reason, 'self_pay_not_permitted', 'an unrecorded rule never permits it');
  });
});

describe('insurance records, permissions and rollout', () => {
  it('requires the insurance workflow and policy 14 to upload insurance records', () => {
    const mutation = { clientId: 1, op: 'put', table: 'cover_check', id: 'check:x', data: {} } as const;
    assert.equal(UploadRequest.safeParse({ transactionId: null, mutations: [mutation], facilityContractVersion: 1, schemaVersion: 5, policyVersion: 13 }).success, false);
    assert.equal(UploadRequest.safeParse({ transactionId: null, mutations: [mutation], insuranceWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: 14 }).success, true);
  });
  it('grants contract access by duty, never by seniority', () => {
    assert.ok(!ROLE_PERMISSIONS.supervisor.some((p) => p.startsWith('insurance_contract') || p === 'coverage:confirm'));
    assert.ok(ROLE_PERMISSIONS.supervisor.includes('payment:refund'));
    assert.deepEqual([...ROLE_PERMISSIONS.cashier].sort(), ['coverage:elect_self_pay', 'payment:receive']);
    assert.ok(ROLE_PERMISSIONS.insurance_officer.includes('coverage:confirm') && !ROLE_PERMISSIONS.insurance_officer.includes('insurance_contract:activate') && !ROLE_PERMISSIONS.insurance_officer.includes('payment:refund'));
    const admin = ROLE_PERMISSIONS.facility_admin;
    assert.ok(admin.includes('insurance_contract:activate') && !admin.includes('insurance_contract:read') && !admin.includes('coverage:confirm'));
  });
  it('a self-pay election records the patient agreement and, when not eligible, the check', () => {
    const election = { ...base, type: 'coverage_election', id: 'el:x', createdOn: at('2026-03-10'), patientId: PATIENT, kind: 'self_pay', coverId: 'cover:one', chargeIds: ['c:1'] };
    assert.equal(CoverageElection.safeParse({ ...election, reason: 'patient_choice' }).success, false);
    assert.equal(CoverageElection.safeParse({ ...election, reason: 'not_eligible', patientAgreed: true }).success, false);
    assert.equal(CoverageElection.safeParse({ ...election, reason: 'patient_choice', patientAgreed: true }).success, true);
  });
  it('a refund is allocated in full and numbered by the server', () => {
    const refund = { ...base, type: 'refund', id: 'refund:abcdefgh', createdOn: at('2026-03-10'), patientId: PATIENT, refundNumber: 'TEST-F-000001', method: 'cash', amountMinor: 100, currency: 'NGN', reason: 'Synthetic', allocations: [{ chargeId: 'c:1', amountMinor: 100 }] };
    assert.equal(Refund.safeParse(refund).success, true);
    assert.equal(Refund.safeParse({ ...refund, amountMinor: 90 }).success, false);
    assert.equal(Refund.safeParse({ ...refund, refundNumber: 'TEST-R-000001-K2' }).success, false);
  });
});
