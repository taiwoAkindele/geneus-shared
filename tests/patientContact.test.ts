import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PatientContact, SCHEMA_BY_TYPE, agreedChannels, currentPatientContact, parseDocument } from '../src/index.ts';

const base = { facilityId: 'TEST', deviceId: 'device:one', schemaVersion: 5, createdBy: 'staff:one', type: 'patient_contact' as const };
const PATIENT = 'TEST-000001-K2';
const contact = (extra: Record<string, unknown> = {}) => PatientContact.parse({ ...base, id: 'contact:one', createdOn: '2026-11-21T10:00:00.000Z', patientId: PATIENT, smsConsent: true, emailConsent: false, ...extra });

describe('patient contact', () => {
  it('is a registered record type', () => {
    assert.equal(SCHEMA_BY_TYPE.patient_contact, PatientContact);
    assert.equal(parseDocument(contact()).success, true);
  });
  it('tidies the email address and refuses a malformed one', () => {
    assert.equal(contact({ email: '  Ada@Example.COM ' }).email, 'ada@example.com');
    assert.throws(() => contact({ email: 'not-an-email' }));
  });
  it('needs an email address before email consent', () => {
    assert.throws(() => contact({ emailConsent: true }), /Add an email address/);
    assert.equal(contact({ emailConsent: true, email: 'ada@example.com' }).emailConsent, true);
  });
  it('the current choice is the one no later record replaces', () => {
    const first = contact();
    const second = contact({ id: 'contact:two', createdOn: '2026-11-22T10:00:00.000Z', replaces: 'contact:one', smsConsent: false });
    const other = contact({ id: 'contact:x', createdOn: '2026-11-23T10:00:00.000Z', patientId: 'TEST-000002-K3' });
    assert.equal(currentPatientContact([second, first, other], PATIENT)?.id, 'contact:two');
    assert.equal(currentPatientContact([other], PATIENT), undefined);
  });
  it('offers only agreed channels that can be reached', () => {
    assert.deepEqual(agreedChannels(undefined, '08031234567'), []);
    assert.deepEqual(agreedChannels(contact(), '08031234567'), ['sms']);
    assert.deepEqual(agreedChannels(contact(), ''), []);
    assert.deepEqual(agreedChannels(contact({ email: 'ada@example.com', emailConsent: true }), '08031234567'), ['sms', 'email']);
  });
});
