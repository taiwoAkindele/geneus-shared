import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnyDocument, parseDocument, SCHEMA_BY_TYPE } from '../src/index.ts';
import { DocType, IMMUTABLE_ENVELOPE_FIELDS, PATIENT_ID_RE, RECEIPT_NUMBER_RE, SCHEMA_VERSION } from '../src/common.ts';
import {
  Appointment,
  AuditEvent,
  Charge,
  CLOSING_STEPS,
  Device,
  Encounter,
  EncounterEntry,
  ExemptionRule,
  FeeItem,
  findExemption,
  Handoff,
  normalizePinSetupCode,
  Patient,
  Payment,
  PinSetupCode,
  RosterShift,
  rosterSignaturePayload,
  SyncRejection,
} from '../src/documents.ts';

const envelope = {
  facilityId: 'OOE-PHC',
  createdBy: 'staff:one',
  createdOn: '2026-09-12T09:30:00+01:00',
  deviceId: 'device-one',
};

const patient = {
  ...envelope,
  id: 'OOE-PHC-000047-K2',
  type: 'patient',
  patientId: 'OOE-PHC-000047-K2',
  fullName: 'Amaka Okoro',
  address: 'Odo-Ona',
  sex: 'female',
  ageYears: 32,
};

describe('the v3 envelope', () => {
  it('is version 3', () => {
    assert.equal(SCHEMA_VERSION, 3);
  });

  it('keys records by `id` and stamps the current schema version by default', () => {
    const parsed = Patient.parse(patient);

    assert.equal(parsed.id, 'OOE-PHC-000047-K2');
    assert.equal(parsed.schemaVersion, 3);
  });

  /** A record still carrying the CouchDB key must fail loudly, not slip through as id-less. */
  it('rejects a record that only has the old `_id`', () => {
    const { id: _id, ...legacy } = patient;

    const result = parseDocument({ ...legacy, _id: 'OOE-PHC-000047-K2' });

    assert.equal(result.success, false);
  });

  it('names the identity fields a PATCH may never move', () => {
    assert.deepEqual([...IMMUTABLE_ENVELOPE_FIELDS], ['id', 'facilityId', 'createdBy', 'createdOn', 'deviceId']);
  });
});

describe('record types', () => {
  it('has exactly one schema per document type, and the union covers all of them', () => {
    assert.deepEqual(Object.keys(SCHEMA_BY_TYPE).sort(), [...DocType.options].sort());
    assert.equal(AnyDocument.options.length, DocType.options.length);
  });

  it('accepts a roster shift that the server has not signed yet', () => {
    const shift = RosterShift.parse({
      ...envelope,
      id: 'roster_shift:staff:one:2026-09-12',
      type: 'roster_shift',
      staffId: 'staff:one',
      startsAt: '2026-09-12T08:00:00+01:00',
      endsAt: '2026-09-12T16:00:00+01:00',
    });

    assert.equal(shift.signature, undefined);
  });

  it('describes a device without ever carrying its credential', () => {
    const device = Device.parse({
      ...envelope,
      id: 'device-one',
      type: 'device',
      enrolledBy: 'staff:one',
      enrolledOn: '2026-09-12T09:00:00+01:00',
    });

    assert.equal(device.status, 'active');
    assert.equal(device.wipeRequested, false);
    assert.equal('credential' in device, false);
    assert.equal(Object.keys(Device.shape).some((key) => /credential|secret|hash/i.test(key)), false);
  });

  it('records an audit event as ok unless told otherwise, with the server clock absent until arrival', () => {
    const event = AuditEvent.parse({
      ...envelope,
      id: 'audit_event:1',
      type: 'audit_event',
      action: 'create',
      entityType: 'patient',
      entityId: patient.id,
      occurredOn: envelope.createdOn,
    });

    assert.equal(event.result, 'ok');
    assert.equal(event.receivedOn, undefined);
  });

  it('keeps audit metadata to scalars, so clinical payloads cannot be tucked into it', () => {
    const result = AuditEvent.safeParse({
      ...envelope,
      id: 'audit_event:2',
      type: 'audit_event',
      action: 'update',
      occurredOn: envelope.createdOn,
      metadata: { patient: { fullName: 'Amaka Okoro' } },
    });

    assert.equal(result.success, false);
  });

  it('carries both sides of a conflict in a sync rejection', () => {
    const rejection = SyncRejection.parse({
      ...envelope,
      createdBy: 'system',
      id: 'sync_rejection:1',
      type: 'sync_rejection',
      entityType: 'patient',
      entityId: patient.id,
      operation: 'patch',
      category: 'conflict',
      reason: 'phone changed on two devices',
      attributedTo: 'staff:one',
      conflicts: [{ column: 'phone', deviceValue: '0801', serverValue: '0802' }],
    });

    assert.equal(rejection.conflicts?.length, 1);
    assert.equal(rejection.resolvedOn, undefined);
  });

  it('keeps the whole refused record on a refused insert, so nothing is lost', () => {
    const rejection = SyncRejection.parse({
      ...envelope,
      createdBy: 'system',
      id: 'sync_rejection:2',
      type: 'sync_rejection',
      entityType: 'patient',
      entityId: patient.id,
      operation: 'put',
      category: 'conflict',
      reason: 'a record with this identity already exists',
      refusedRecord: patient,
    });

    assert.equal(rejection.refusedRecord?.fullName, 'Amaka Okoro');
  });

  it('keeps what a wholly refused change tried to set', () => {
    const rejection = SyncRejection.parse({
      ...envelope,
      createdBy: 'system',
      id: 'sync_rejection:3',
      type: 'sync_rejection',
      entityType: 'patient',
      entityId: patient.id,
      operation: 'patch',
      category: 'authorization',
      reason: 'staff:one is deactivated',
      refusedChanges: { phone: '0803 555 0147' },
    });

    assert.deepEqual(rejection.refusedChanges, { phone: '0803 555 0147' });
  });

  it('refuses an unknown type', () => {
    assert.equal(parseDocument({ ...envelope, id: 'x', type: 'prescription' }).success, false);
  });
});

describe('roster signatures', () => {
  const shift = {
    staffId: 'staff:one',
    facilityId: 'OOE-PHC',
    startsAt: '2026-09-12T08:00:00+01:00',
    endsAt: '2026-09-12T16:00:00+01:00',
  };

  it('signs the same bytes however each side formats the same instant', () => {
    const fromPostgres = { ...shift, startsAt: '2026-09-12T07:00:00.000Z', endsAt: '2026-09-12T15:00:00.000Z' };
    assert.equal(rosterSignaturePayload(fromPostgres), rosterSignaturePayload(shift));
  });

  it('covers the supervisor extension, so it cannot be added under an old signature', () => {
    const extended = { ...shift, extendedUntil: '2026-09-12T20:00:00+01:00' };
    assert.notEqual(rosterSignaturePayload(extended), rosterSignaturePayload(shift));
  });
});

describe('PIN setup codes', () => {
  const code = {
    ...envelope,
    id: 'pin_setup_code:one',
    type: 'pin_setup_code',
    staffId: 'staff:two',
    codeHash: 'aGFzaA==',
    codeSalt: 'c2FsdA==',
    codeIterations: 100_000,
    expiresOn: '2026-09-13T09:30:00+01:00',
  };

  it('carries the hash of the code, never the code itself', () => {
    const parsed = PinSetupCode.parse(code);
    assert.equal('code' in parsed, false);
    assert.equal(parseDocument(code).success, true);
  });

  it('ignores case and spaces in a code read aloud', () => {
    assert.equal(normalizePinSetupCode(' ab3d ef7h '), 'AB3DEF7H');
  });
});

describe('Patient IDs', () => {
  it('accepts a facility code of one segment or several', () => {
    assert.match('OOE-PHC-000047-K2', PATIENT_ID_RE);
    assert.match('OOE-000047-K2', PATIENT_ID_RE);
  });

  it('refuses an id without the sequence or the safety code', () => {
    assert.doesNotMatch('OOE-PHC-47-K2', PATIENT_ID_RE);
    assert.doesNotMatch('OOE-PHC-000047', PATIENT_ID_RE);
    assert.doesNotMatch('ooe-phc-000047-k2', PATIENT_ID_RE);
  });
});

describe('encounters', () => {
  const encounter = {
    ...envelope,
    id: 'encounter:1',
    type: 'encounter',
    patientId: patient.id,
    openedOn: '2026-09-12T09:31:00+01:00',
  };

  const entry = (step: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...envelope,
    id: `encounter_entry:${step}`,
    type: 'encounter_entry',
    encounterId: encounter.id,
    patientId: patient.id,
    step,
    actorRole: 'nurse',
    values,
    ...extra,
  });

  it('opens an encounter in the facility unless told otherwise', () => {
    assert.equal(Encounter.parse(encounter).setting, 'facility');
  });

  it('saves a step whose values fit that step', () => {
    const vitals = entry('vitals', { temperatureC: 38.9, systolicMmHg: 118, diastolicMmHg: 76 });

    assert.equal(parseDocument(vitals).success, true);
  });

  it('refuses an empty step, so a save always records something', () => {
    assert.equal(EncounterEntry.safeParse(entry('vitals', {})).success, false);
    assert.equal(EncounterEntry.safeParse(entry('complaint', {})).success, false);
  });

  it("refuses a field that belongs to another step, naming where it went wrong", () => {
    const result = EncounterEntry.safeParse(entry('vitals', { temperatureC: 37, diagnosis: 'Malaria' }));

    assert.equal(result.success, false);
    assert.equal(result.error?.issues[0]?.path[0], 'values');
  });

  it('asks for a reason when a prescribed drug is not dispensed', () => {
    const withoutReason = entry('dispense', { lines: [{ drug: 'Artemether-Lumefantrine', dispensed: false }] });
    const withReason = entry('dispense', {
      lines: [{ drug: 'Artemether-Lumefantrine', dispensed: false, reason: 'Out of stock' }],
    });

    assert.equal(EncounterEntry.safeParse(withoutReason).success, false);
    assert.equal(EncounterEntry.safeParse(withReason).success, true);
  });

  /** Corrections are added, never written over the original (PRD §9.8.3). */
  it('links an amendment to the entry it corrects, and only an amendment', () => {
    const amendment = entry('amendment', { note: 'Temperature was 37.9, not 38.9' }, { amends: 'encounter_entry:vitals' });
    const unlinked = entry('amendment', { note: 'Temperature was 37.9' });
    const linkedVitals = entry('vitals', { temperatureC: 37.9 }, { amends: 'encounter_entry:vitals' });

    assert.equal(EncounterEntry.safeParse(amendment).success, true);
    assert.equal(EncounterEntry.safeParse(unlinked).success, false);
    assert.equal(EncounterEntry.safeParse(linkedVitals).success, false);
  });

  it('closes on admission or follow-up, and a follow-up need not book a review', () => {
    assert.deepEqual([...CLOSING_STEPS], ['admission', 'follow_up']);
    assert.equal(EncounterEntry.safeParse(entry('follow_up', {})).success, true);
  });

  it('keeps entry values in one column, as both consumers derive tables from the shape', () => {
    assert.ok('values' in EncounterEntry.shape);
    assert.ok('encounterId' in Handoff.shape);
  });

  /** Seeing a patient before they pay is allowed, and recorded with why (PRD §9.13.5). */
  it('links the appointment it was booked as and keeps why it went ahead unpaid', () => {
    const opened = Encounter.parse({
      ...encounter,
      appointmentId: 'appointment:1',
      collectLaterReason: 'Emergency — febrile convulsion',
    });

    assert.equal(opened.appointmentId, 'appointment:1');
    assert.equal(Encounter.safeParse({ ...encounter, collectLaterReason: '   ' }).success, false);
  });
});

describe('appointments', () => {
  const appointment = {
    ...envelope,
    id: 'appointment:1',
    type: 'appointment',
    patientId: patient.id,
    reason: 'Antenatal booking',
  };

  it('records the visit type, and still reads bookings made before it existed', () => {
    assert.equal(Appointment.parse({ ...appointment, visitType: 'antenatal' }).visitType, 'antenatal');
    assert.equal(Appointment.safeParse(appointment).success, true);
    assert.equal(Appointment.safeParse({ ...appointment, visitType: 'surgery' }).success, false);
  });
});

describe('billing', () => {
  const consultation = {
    ...envelope,
    id: 'fee_item:consultation',
    type: 'fee_item',
    name: 'Consultation',
    category: 'consultation',
    amountMinor: 150000,
    currency: 'NGN',
    chargeWhen: 'every_visit',
    exemptions: [{ reason: 'Under-5 policy', ageUnderYears: 5 }],
  };

  const charge = {
    ...envelope,
    id: 'charge:1',
    type: 'charge',
    patientId: patient.id,
    feeItemId: consultation.id,
    description: 'Consultation',
    category: 'consultation',
    listPriceMinor: 150000,
    amountMinor: 150000,
    currency: 'NGN',
    appointmentId: 'appointment:1',
  };

  const payment = {
    ...envelope,
    id: 'payment:1',
    type: 'payment',
    patientId: patient.id,
    receiptNumber: 'OOE-PHC-R-000123-K2',
    method: 'cash',
    amountMinor: 150000,
    currency: 'NGN',
    allocations: [{ chargeId: charge.id, amountMinor: 150000 }],
  };

  it('keeps a fee in whole minor units with its currency, active unless retired', () => {
    const fee = FeeItem.parse(consultation);

    assert.equal(fee.active, true);
    assert.equal(FeeItem.safeParse({ ...consultation, amountMinor: 1500.5 }).success, false);
    assert.equal(FeeItem.safeParse({ ...consultation, currency: 'naira' }).success, false);
  });

  it('refuses an exemption with no condition, or one no patient could meet', () => {
    assert.equal(ExemptionRule.safeParse({ reason: 'Free' }).success, false);
    assert.equal(ExemptionRule.safeParse({ reason: 'Impossible', ageFromYears: 10, ageUnderYears: 5 }).success, false);
    assert.equal(ExemptionRule.safeParse({ reason: 'Elderly', ageFromYears: 65 }).success, true);
  });

  describe('exemptions', () => {
    const rules = [
      ExemptionRule.parse({ reason: 'Under-5 policy', ageUnderYears: 5 }),
      ExemptionRule.parse({ reason: 'Free antenatal care', sex: 'female', visitTypes: ['antenatal', 'postnatal'] }),
    ];

    it('finds the rule that makes a fee free', () => {
      assert.equal(findExemption(rules, { ageYears: 3, sex: 'male' })?.reason, 'Under-5 policy');
      assert.equal(findExemption(rules, { ageYears: 28, sex: 'female', visitType: 'antenatal' })?.reason, 'Free antenatal care');
    });

    it('needs every condition of a rule to hold', () => {
      assert.equal(findExemption(rules, { ageYears: 28, sex: 'female', visitType: 'general' }), undefined);
      assert.equal(findExemption(rules, { ageYears: 5, sex: 'male' }), undefined);
    });

    /** A mother must not be charged by mistake, but nobody is exempted on a guess either. */
    it('never matches on something that was not recorded', () => {
      assert.equal(findExemption(rules, { sex: 'male' }), undefined);
      assert.equal(findExemption(rules, { ageYears: 28, sex: 'female' }), undefined);
    });
  });

  it('owes the full price, or nothing when exempt — never anything in between', () => {
    assert.equal(Charge.safeParse(charge).success, true);
    assert.equal(Charge.safeParse({ ...charge, amountMinor: 0, exemptionReason: 'Under-5 policy' }).success, true);
    assert.equal(Charge.safeParse({ ...charge, amountMinor: 0 }).success, false);
    assert.equal(Charge.safeParse({ ...charge, amountMinor: 100000 }).success, false);
    assert.equal(Charge.safeParse({ ...charge, exemptionReason: 'Under-5 policy' }).success, false);
  });

  it('takes a payment allocated to charges in full', () => {
    assert.equal(parseDocument(payment).success, true);
  });

  it('refuses a payment whose allocations do not add up, or name a charge twice', () => {
    const short = { ...payment, allocations: [{ chargeId: charge.id, amountMinor: 100000 }] };
    const twice = {
      ...payment,
      allocations: [
        { chargeId: charge.id, amountMinor: 75000 },
        { chargeId: charge.id, amountMinor: 75000 },
      ],
    };

    assert.equal(Payment.safeParse(short).success, false);
    assert.equal(Payment.safeParse(twice).success, false);
  });

  it('asks why for a waiver or a reversal', () => {
    const waiver = { ...payment, method: 'waiver' };
    const reversal = { ...payment, reverses: 'payment:0' };

    assert.equal(Payment.safeParse(waiver).success, false);
    assert.equal(Payment.safeParse({ ...waiver, reason: 'Destitute — approved by supervisor' }).success, true);
    assert.equal(Payment.safeParse(reversal).success, false);
    assert.equal(Payment.safeParse({ ...reversal, reason: 'Entered twice' }).success, true);
  });

  it('refuses a payment without a receipt number in the facility format', () => {
    assert.equal(Payment.safeParse({ ...payment, receiptNumber: '123' }).success, false);
  });
});

describe('receipt numbers', () => {
  it('reads like a Patient ID with an R before the sequence', () => {
    assert.match('OOE-PHC-R-000123-K2', RECEIPT_NUMBER_RE);
    assert.match('OOE-R-000123-K2', RECEIPT_NUMBER_RE);
  });

  it('refuses a number without the R, the sequence or the safety code', () => {
    assert.doesNotMatch('OOE-PHC-000123-K2', RECEIPT_NUMBER_RE);
    assert.doesNotMatch('OOE-PHC-R-123-K2', RECEIPT_NUMBER_RE);
    assert.doesNotMatch('OOE-PHC-R-000123', RECEIPT_NUMBER_RE);
  });
});
