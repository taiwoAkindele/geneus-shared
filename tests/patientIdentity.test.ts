import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeIdentityLinks, canonicalPatientId, linkedPatientIds, patientAge, validCalendarDate, yearsBetween, type IdentityEvent } from '../src/patientIdentity.ts';
import { Patient } from '../src/documents.ts';

describe('patient age and identity', () => {
  it('uses calendar birthdays, including the day before a birthday', () => {
    assert.equal(yearsBetween('1994-10-25', '2026-10-24'), 31);
    assert.equal(yearsBetween('1994-10-25', '2026-10-25'), 32);
    assert.equal(patientAge({ ageYears: 40, ageObservedOn: '2024-10-25', createdOn: '2020-01-01' }, '2026-10-24'), 41);
    assert.equal(patientAge({ ageYears: 40, createdOn: '2024-10-25' }, '2026-10-25'), 42);
    assert.equal(validCalendarDate('2025-02-29'), false);
    assert.equal(validCalendarDate('2024-02-29'), true);
  });
  it('normalises explicitly cleared patient values without removing age evidence', () => {
    const p = Patient.parse({ id: 'OOE-000001-K2', patientId: 'OOE-000001-K2', type: 'patient', facilityId: 'OOE', createdBy: 'staff', deviceId: 'device', createdOn: '2026-10-25T00:00:00Z', fullName: 'Test', address: 'Test', sex: 'female', ageYears: 20, ageObservedOn: '2026-10-25', phone: null, nin: null, dateOfBirth: null });
    assert.equal(p.phone, undefined); assert.equal(p.dateOfBirth, undefined); assert.equal(p.ageYears, 20);
    assert(!Patient.safeParse({ ...p, dateOfBirth: '2000-02-30' }).success);
    assert(!Patient.safeParse({ ...p, dateOfBirth: '2000-01-01' }).success);
  });
  const event = (revision: number, patientId: string, otherPatientId: string, outcome: IdentityEvent['outcome'] = 'linked'): IdentityEvent => ({ id: `e${revision}`, revision, patientId, otherPatientId, outcome });
  it('recognises transitive aliases and corrects a link without rewriting records', () => {
    const events = [event(1, 'a', 'b'), event(2, 'c', 'a')];
    assert.equal(canonicalPatientId('b', events), 'c');
    assert.deepEqual(linkedPatientIds('b', events).sort(), ['a', 'b', 'c']);
    events.push(event(3, 'c', 'a', 'unlinked'));
    assert.equal(canonicalPatientId('b', events), 'a');
    assert.deepEqual(linkedPatientIds('c', events), ['c']);
  });
  it('ignores an unconfirmed local link and detects corrupt cycles', () => {
    assert.equal(activeIdentityLinks([{ ...event(1, 'a', 'b'), revision: undefined }]).size, 0);
    assert.throws(() => canonicalPatientId('a', [event(1, 'a', 'b'), event(2, 'b', 'a')]), /cycle/);
  });
});
