import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PatientContact, SCHEMA_BY_TYPE, availableChannels, contactChangeProblem, currentPatientContact, parseDocument } from '../src/index.ts';

const base = { facilityId: 'TEST', deviceId: 'device:one', schemaVersion: 5, createdBy: 'staff:one', type: 'patient_contact' as const };
const PATIENT = 'TEST-000001-K2';
const contact = (extra: Record<string, unknown> = {}) => PatientContact.parse({ ...base, id: 'contact:one', createdOn: '2026-11-21T10:00:00.000Z', patientId: PATIENT, smsStopped: false, emailStopped: false, source: 'staff', ...extra });

describe('patient contact', () => {
  it('is a registered record type', () => {
    assert.equal(SCHEMA_BY_TYPE.patient_contact, PatientContact);
    assert.equal(parseDocument(contact()).success, true);
  });
  it('tidies the email address and refuses a malformed one', () => {
    assert.equal(contact({ email: '  Ada@Example.COM ' }).email, 'ada@example.com');
    assert.throws(() => contact({ email: 'not-an-email' }));
    assert.throws(() => contact({ source: 'hospital' }));
  });
  it('the current record is the one no later record replaces', () => {
    const first = contact();
    const second = contact({ id: 'contact:two', createdOn: '2026-11-22T10:00:00.000Z', replaces: 'contact:one', smsStopped: true });
    const other = contact({ id: 'contact:x', createdOn: '2026-11-23T10:00:00.000Z', patientId: 'TEST-000002-K3' });
    assert.equal(currentPatientContact([second, first, other], PATIENT)?.id, 'contact:two');
    assert.equal(currentPatientContact([other], PATIENT), undefined);
  });
  it('sends to contact details on file unless the patient stopped that channel', () => {
    assert.deepEqual(availableChannels(undefined, '08031234567'), ['sms']);
    assert.deepEqual(availableChannels(undefined, ''), []);
    assert.deepEqual(availableChannels(contact({ email: 'ada@example.com' }), '08031234567'), ['sms', 'email']);
    assert.deepEqual(availableChannels(contact({ email: 'ada@example.com', smsStopped: true }), '08031234567'), ['email']);
    assert.deepEqual(availableChannels(contact({ email: 'ada@example.com', emailStopped: true }), ''), []);
  });
  it('only the patient can start a channel they stopped', () => {
    const stopped = contact({ email: 'ada@example.com', smsStopped: true, emailStopped: true, source: 'patient' });
    assert.match(contactChangeProblem(stopped, contact({ email: 'ada@example.com', emailStopped: true }))!, /stopped SMS/);
    assert.match(contactChangeProblem(stopped, contact({ email: 'ada@example.com', smsStopped: true }))!, /stopped email/);
    assert.equal(contactChangeProblem(stopped, contact({ email: 'ada@example.com', source: 'patient' })), undefined);
  });
  it('staff can record a stop and change the email; a patient change keeps the details', () => {
    const first = contact({ email: 'ada@example.com' });
    assert.equal(contactChangeProblem(first, contact({ email: 'new@example.com', smsStopped: true })), undefined);
    assert.match(contactChangeProblem(first, contact({ email: 'new@example.com', source: 'patient' }))!, /contact details/);
    assert.match(contactChangeProblem(first, contact({ patientId: 'TEST-000002-K3' }))!, /different patient/);
    assert.equal(contactChangeProblem(undefined, contact()), undefined);
  });
});
