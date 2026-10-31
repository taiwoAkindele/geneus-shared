import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Patient, patientIdentificationIssues, patientIdentitySnapshot, patientSexLabel, provisionalPatientName } from '../src/index.ts';

const id = 'TEST-PHC-000001-K2';
const base = { id, patientId: id, type: 'patient', facilityId: 'TEST-PHC', createdBy: 'staff:one', createdOn: '2026-10-31T09:00:00Z', deviceId: 'device:one' };
const provisional = () => Patient.parse({ ...base, fullName: provisionalPatientName(id), identityStatus: 'provisional', provisionalReason: 'Identity unknown on arrival' });
const identified = () => Patient.parse({ ...provisional(), fullName: 'Synthetic Identified Patient', identityStatus: 'identified', address: 'Synthetic address', sex: 'female', ageYears: 30, identifiedBy: 'staff:two', identifiedOn: '2026-10-31T10:00:00Z', identificationNote: 'Representative supplied identity information', identificationBase: patientIdentitySnapshot(provisional()) });

describe('provisional patient contract and identity completion', () => {
  it('accepts genuinely unknown demographics without inventing an age or sex', () => {
    const patient = provisional();
    assert.equal(patient.sex, undefined); assert.equal(patient.address, undefined); assert.equal(patient.ageYears, undefined);
    assert.equal(patientSexLabel(patient.sex), 'Sex not recorded');
    assert.notEqual(provisionalPatientName(id), provisionalPatientName('TEST-PHC-000002-K2'));
  });
  it('retains ordinary registration requirements and reads legacy identified records', () => {
    assert.equal(Patient.safeParse({ ...base, fullName: 'Known person' }).success, false);
    assert.equal(Patient.parse({ ...base, schemaVersion: 4, fullName: 'Known person', address: 'Known address', sex: 'male', ageYears: 25 }).identityStatus, 'identified');
  });
  it('requires a reason, distinct temporary label and compatible schema for provisional registration', () => {
    const patient = provisional();
    for (const change of [{ provisionalReason: '' }, { fullName: 'Unknown person' }, { schemaVersion: 4 }, { identifiedBy: 'staff:two' }]) assert.equal(Patient.safeParse({ ...patient, ...change }).success, false);
  });
  it('requires known demographics and attribution to complete identification', () => {
    const patient = identified();
    for (const change of [{ sex: null }, { address: null }, { ageYears: null }, { identifiedBy: null }, { identificationNote: null }]) assert.equal(Patient.safeParse({ ...patient, ...change }).success, false);
    assert.deepEqual(patientIdentificationIssues(provisional(), patient, 'staff:two', patient.identifiedOn!), []);
    assert.ok(patientIdentificationIssues(provisional(), patient, 'staff:other', patient.identifiedOn!).length);
    assert.ok(patientIdentificationIssues({ ...provisional(), phone: '08000000001' }, patient, 'staff:two', patient.identifiedOn!).length);
  });
  it('keeps the original circumstances and completed attribution immutable', () => {
    const patient = identified();
    for (const change of [{ provisionalReason: 'Different original reason' }, { identifiedBy: 'staff:other' }, { identificationNote: 'Replace the historical explanation' }, { identityStatus: 'provisional' as const }]) assert.ok(patientIdentificationIssues(patient, { ...patient, ...change }, 'staff:two', patient.identifiedOn!).length);
    assert.deepEqual(patientIdentificationIssues(patient, { ...patient, phone: '08000000001' }, 'staff:two', '2026-10-31T11:00:00Z'), []);
  });
});
