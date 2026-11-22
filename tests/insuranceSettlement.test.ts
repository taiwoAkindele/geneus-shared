import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthorizationInput,
  LiabilityChange,
  PayerDecisionInput,
  RemittanceInput,
  SubmissionProfile,
  ROLE_PERMISSIONS,
  approvalNeeded,
  assessClaimDiagnoses,
  claimSettlement,
  diagnosisCodeWellFormed,
  matchRemittanceRows,
  serviceFulfillment,
  type Charge,
  type CoverSchedule,
  type EncounterEntry,
  type PatientCover,
  type ServiceCompletion,
} from '../src/index.ts';

// Synthetic payers, codes and prices only.
const PATIENT = 'TEST-000001-K2';

describe('diagnosis requirements (audit H1)', () => {
  const recorded = [{ label: 'Malaria', code: 'b54', codingSystem: 'ICD-10' }];

  const assess = (
    requirement: 'codes_verified' | 'codes_as_entered' | 'free_text' | 'not_required',
    codes: Record<string, string> = {},
    list = recorded,
  ) =>
    assessClaimDiagnoses({
      recorded: list,
      requirement,
      codeSystem: 'ICD-10',
      catalogueSize: Object.keys(codes).length,
      lookup: (c) => codes[c],
    });

  it('reads the earlier strict setting as verified codes, never weaker', () => {
    assert.equal(
      SubmissionProfile.parse({
        method: 'manual',
        channel: 'physical',
        diagnosisRequirement: 'coded_icd10',
      }).diagnosisRequirement,
      'codes_verified',
    );

    assert.equal(
      SubmissionProfile.parse({ method: 'manual', channel: 'physical' }).diagnosisRequirement,
      'codes_verified',
    );
  });

  it("verified codes need the hospital's catalogue and a code in it", () => {
    assert.deepEqual(
      assess('codes_verified').issues.map((i) => i.code),
      ['diagnosis_catalogue_missing'],
    );

    assert.deepEqual(
      assess('codes_verified', { A00: 'Cholera' }).issues.map((i) => i.code),
      ['diagnosis_code_not_in_catalogue'],
    );

    const ok = assess('codes_verified', { B54: 'Unspecified malaria' });
    assert.deepEqual(ok.issues, []);
    assert.deepEqual(
      [ok.diagnoses[0].code, ok.diagnoses[0].verification],
      ['B54', 'catalogue_verified'],
    );
  });

  it('codes as entered pass on format alone, and say so', () => {
    const r = assess('codes_as_entered');
    assert.deepEqual([r.issues, r.diagnoses[0].verification], [[], 'format_checked']);
    assert.deepEqual(
      assess('codes_as_entered', {}, [
        { label: 'x', code: 'MAL', codingSystem: 'ICD-10' },
      ]).issues.map((i) => i.code),
      ['diagnosis_code_format'],
    );

    assert.deepEqual(
      assess('codes_as_entered', {}, [{ label: 'Malaria' }]).issues.map((i) => i.code),
      ['diagnosis_code_missing'],
    );
  });

  it('written diagnoses only where the payer accepts them; none at all only where none is required', () => {
    assert.deepEqual(assess('free_text', {}, [{ label: 'Malaria' }]).issues, []);
    assert.deepEqual(
      assess('free_text', {}, []).issues.map((i) => i.code),
      ['diagnosis_missing'],
    );

    assert.deepEqual(assess('not_required', {}, []).issues, []);
  });

  it('knows the shape of an ICD-10 code and refuses spreadsheet formulas', () => {
    for (const code of ['B54', 'K35.8', 'J45.909', 'U07.1'.replace('U', 'A')]) {
      assert.ok(diagnosisCodeWellFormed('ICD-10', code), code);
    }

    for (const code of ['MAL', '54B', '=1+1', 'B5', '']) {
      assert.ok(!diagnosisCodeWellFormed('ICD-10', code), code);
    }
  });
});

describe('consultation evidence', () => {
  const charge = {
    id: 'charge:c',
    patientId: PATIENT,
    category: 'consultation',
    feeItemId: 'fee:consult',
    encounterId: 'enc:1',
  } as unknown as Charge;

  const entry = (actorRole: string, step: string) =>
    ({
      id: `e:${actorRole}:${step}`,
      encounterId: 'enc:1',
      actorRole,
      step,
      createdOn: '2026-11-01T10:00:00Z',
      createdBy: 'staff',
      values: {},
    }) as unknown as EncounterEntry;

  it("a nurse's vitals or triage do not show a consultation; a doctor's or CHEW's clinical entry does", () => {
    assert.equal(
      serviceFulfillment(charge, {
        results: [],
        visitEntries: [entry('nurse', 'vitals'), entry('nurse', 'complaint')],
      }).kind,
      'missing',
    );

    assert.equal(
      serviceFulfillment(charge, { results: [], visitEntries: [entry('doctor', 'vitals')] }).kind,
      'missing',
      'vitals are not a consultation, whoever took them',
    );

    assert.equal(
      serviceFulfillment(charge, { results: [], visitEntries: [entry('chew', 'complaint')] }).kind,
      'visit',
    );

    assert.equal(
      serviceFulfillment(charge, { results: [], visitEntries: [entry('doctor', 'diagnosis')] })
        .kind,
      'visit',
    );
  });

  it("a consultation's completion record counts only from someone who consults", () => {
    const completion = (actorRole: string) =>
      ({
        id: 'c',
        chargeId: 'charge:c',
        status: 'completed',
        actorRole,
        completedOn: '2026-11-01T10:00:00Z',
        createdBy: 's',
      }) as unknown as ServiceCompletion;

    assert.equal(
      serviceFulfillment(charge, { results: [], visitEntries: [], completion: completion('nurse') })
        .kind,
      'missing',
    );

    assert.equal(
      serviceFulfillment(charge, {
        results: [],
        visitEntries: [],
        completion: completion('doctor'),
      }).kind,
      'completion',
    );
  });
});

describe('authorization at the point of care (audit H2)', () => {
  const cover = {
    id: 'cover:1',
    patientId: PATIENT,
    payerId: 'payer:s',
    planCode: 'GOLD',
    active: true,
  } as unknown as PatientCover;

  const schedule = {
    id: 'sch:1',
    payerId: 'payer:s',
    planCode: 'GOLD',
    contractVersion: 1,
    effectiveFrom: '2026-01-01',
    currency: 'NGN',
    items: {
      'fee:mri': {
        status: 'covered',
        arrangement: 'per_service',
        patient: { kind: 'per_unit', amountMinor: 0 },
        approvalRequired: true,
      },
    },
    categories: {
      laboratory: {
        status: 'covered',
        arrangement: 'per_service',
        patient: { kind: 'per_unit', amountMinor: 0 },
        approvalRequired: false,
      },
    },
  } as unknown as CoverSchedule;

  const records = { covers: [cover], schedules: [schedule] };
  it('warns from the synced schedule, before any check, for services the payer must approve', () => {
    assert.equal(
      approvalNeeded({
        patientId: PATIENT,
        feeItemId: 'fee:mri',
        category: 'imaging',
        date: '2026-11-01',
        records,
      })?.payerId,
      'payer:s',
    );

    assert.equal(
      approvalNeeded({
        patientId: PATIENT,
        feeItemId: 'fee:fbc',
        category: 'laboratory',
        date: '2026-11-01',
        records,
      }),
      undefined,
    );

    assert.equal(
      approvalNeeded({
        patientId: 'OTHER',
        feeItemId: 'fee:mri',
        category: 'imaging',
        date: '2026-11-01',
        records,
      }),
      undefined,
    );
  });

  it('an emergency exception says why care could not wait; quantities name authorized services', () => {
    const base = {
      patientId: PATIENT,
      payerId: 'payer:s',
      kind: 'pre_authorization',
      validFrom: '2026-11-01',
      validTo: '2026-11-02',
      feeItemIds: ['fee:mri'],
      obtainedVia: 'phone',
    };

    assert.equal(
      AuthorizationInput.safeParse({ ...base, status: 'emergency_exception' }).success,
      false,
    );

    assert.equal(
      AuthorizationInput.safeParse({
        ...base,
        status: 'emergency_exception',
        note: 'Unconscious on arrival',
      }).success,
      true,
    );

    assert.equal(
      AuthorizationInput.safeParse({
        ...base,
        status: 'approved',
        reference: 'PA-1',
        approvedQuantities: { 'fee:ct': 1 },
      }).success,
      false,
    );
  });
});

describe('patient liability (audit H3)', () => {
  it('needs the evidence its ground names', () => {
    assert.equal(LiabilityChange.safeParse({ ground: 'patient_election' }).success, false);
    assert.equal(LiabilityChange.safeParse({ ground: 'not_eligible' }).success, false);
    assert.equal(
      LiabilityChange.safeParse({ ground: 'contract_clause', contractClause: '7.2' }).success,
      true,
    );
  });

  it("an insurance officer cannot approve moving a payer's share or write anything off; an administrator can", () => {
    assert.ok(!ROLE_PERMISSIONS.insurance_officer.includes('coverage:approve_liability_change'));
    assert.ok(!ROLE_PERMISSIONS.insurance_officer.includes('billing:write_off'));
    assert.ok(ROLE_PERMISSIONS.insurance_officer.includes('insurance_remittance:record'));

    for (const p of [
      'coverage:approve_liability_change',
      'billing:write_off',
      'insurance_remittance:record',
    ] as const) {
      assert.ok(ROLE_PERMISSIONS.facility_admin.includes(p), p);
    }

    for (const role of ['cashier', 'records_officer', 'supervisor', 'nurse', 'doctor'] as const) {
      assert.ok(!ROLE_PERMISSIONS[role].includes('insurance_remittance:record'), role);
    }
  });
});

describe('settlement (Slice 4)', () => {
  const today = '2026-11-14';

  const s = (input: Partial<Parameters<typeof claimSettlement>[0]>) =>
    claimSettlement({
      submitted: true,
      submittedOn: '2026-10-01',
      expectedMinor: 10_000,
      paidMinor: 0,
      writtenOffMinor: 0,
      openDisputeMinor: 0,
      today,
      ...input,
    });

  it('keeps expected, approved, deducted, paid, written-off and outstanding apart', () => {
    assert.deepEqual(s({}), {
      status: 'awaiting_response',
      expectedMinor: 10_000,
      deductedMinor: 0,
      paidMinor: 0,
      writtenOffMinor: 0,
      disputedMinor: 0,
      outstandingMinor: 10_000,
      payerOwesMinor: 10_000,
      overdue: false,
    });

    const partial = s({
      decision: { decision: 'partially_approved', approvedMinor: 8_000 },
      paidMinor: 8_000,
    });

    assert.deepEqual(
      [
        partial.status,
        partial.approvedMinor,
        partial.deductedMinor,
        partial.outstandingMinor,
        partial.payerOwesMinor,
      ],
      ['partially_paid', 8_000, 2_000, 2_000, 0],
    );

    assert.equal(
      s({
        decision: { decision: 'partially_approved', approvedMinor: 8_000 },
        paidMinor: 8_000,
        writtenOffMinor: 2_000,
      }).status,
      'settled',
    );

    assert.equal(s({ decision: { decision: 'denied', approvedMinor: 0 } }).status, 'denied');
    assert.equal(s({ decision: { decision: 'queried', approvedMinor: 0 } }).status, 'queried');
    assert.equal(s({ openDisputeMinor: 1_000 }).status, 'disputed');
    assert.equal(s({ submitted: false }).status, 'not_submitted');
  });

  it('is overdue only against payment terms the contract states', () => {
    assert.equal(s({}).overdue, false, 'no terms recorded: nothing is called overdue');
    assert.equal(s({ paymentDueDays: 30 }).overdue, true);
    assert.equal(s({ paymentDueDays: 60 }).overdue, false);
  });

  it('validates decisions and remittances before anything is stored', () => {
    assert.equal(
      PayerDecisionInput.safeParse({
        claimId: 'c',
        decision: 'denied',
        decidedOn: '2026-11-01',
        requestKey: 'k'.repeat(8),
      }).success,
      false,
      "a denial needs the payer's reason",
    );

    assert.equal(
      PayerDecisionInput.safeParse({
        claimId: 'c',
        decision: 'queried',
        decidedOn: '2026-11-01',
        reason: 'Q',
        lines: [{ chargeId: 'x', approvedMinor: 1 }],
        requestKey: 'k'.repeat(8),
      }).success,
      false,
    );

    assert.equal(
      RemittanceInput.safeParse({
        payerId: 'p',
        receivedOn: '2026-11-01',
        reference: 'R',
        amountMinor: 100,
        currency: 'NGN',
        method: 'transfer',
        allocations: [{ claimId: 'a', amountMinor: 101 }],
        requestKey: 'k'.repeat(8),
      }).success,
      false,
    );
  });

  it('matches remittance rows by claim number only; anything else waits for a person', () => {
    const claims = [
      {
        claimId: 'c1',
        claimNumber: 'CLM-000001',
        enrolleeNumber: 'SYN-1',
        patientName: 'A',
        outstandingMinor: 5_000,
      },
    ];

    const m = matchRemittanceRows(
      [
        { sourceRow: 2, claimNumber: 'clm-000001', paidMinor: 5_000 },
        { sourceRow: 3, claimNumber: 'CLM-000001', paidMinor: 6_000 },
        { sourceRow: 4, enrolleeNumber: 'syn-1', paidMinor: 1 },
        { sourceRow: 5, claimNumber: 'CLM-9', paidMinor: 1 },
      ],
      claims,
    );

    assert.deepEqual(
      m.map((x) => x.confidence),
      ['exact', 'uncertain', 'uncertain', 'none'],
    );

    assert.match(m[1].problems[0], /more than/);
  });
});
