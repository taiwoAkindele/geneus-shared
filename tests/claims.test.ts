import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Charge, EncounterEntry, ServiceCompletion, currentCompletions, inBillingPeriod, serviceFulfillment } from '../src/index.ts';

const base = { facilityId: 'facility:one', schemaVersion: 5, createdBy: 'staff:doctor', createdOn: '2026-03-10T09:00:00.000Z', deviceId: 'device:one' };
const PATIENT = 'TEST-000001-A1';
const charge = (extra: Record<string, unknown>) => Charge.parse({ ...base, id: 'charge:one', type: 'charge', patientId: PATIENT, feeItemId: 'fee:x', description: 'Synthetic', category: 'procedure', listPriceMinor: 1_000, amountMinor: 1_000, currency: 'NGN', ...extra });
const entry = (id: string, step: string, values: Record<string, unknown>, actorRole = 'doctor', extra: Record<string, unknown> = {}) => EncounterEntry.parse({ ...base, id, type: 'encounter_entry', encounterId: 'encounter:one', patientId: PATIENT, step, actorRole, values, ...extra });
const completion = (id: string, status: 'completed' | 'not_done', extra: Record<string, unknown> = {}) => ServiceCompletion.parse({
  ...base, id, type: 'service_completion', patientId: PATIENT, chargeId: 'charge:one', status, completedOn: '2026-03-10T10:00:00.000Z', actorRole: 'nurse', ...(status === 'not_done' ? { note: 'Declined' } : {}), ...extra,
});
const none = { results: [], visitEntries: [] };

describe('service fulfillment: ordered is not done', () => {
  it('needs evidence that an ordered test was performed: the result naming its order item', () => {
    const ordered = charge({ category: 'laboratory', orderItemId: 'item:1', encounterId: 'encounter:one' });
    assert.deepEqual(serviceFulfillment(ordered, none), { kind: 'missing', ordered: true });
    const other = entry('e:other', 'lab_results', { results: [{ test: 'FBC', result: 'Normal', orderItemId: 'item:2' }] });
    assert.equal(serviceFulfillment(ordered, { ...none, results: [other] }).kind, 'missing', 'another test\'s result does not count');
    const result = entry('e:result', 'lab_results', { results: [{ test: 'RDT', result: 'Positive', orderItemId: 'item:1' }] }, 'laboratory_staff');
    assert.deepEqual(serviceFulfillment(ordered, { ...none, results: [result] }), { kind: 'result', entryId: 'e:result', on: base.createdOn, by: base.createdBy });
  });
  it('shows a consultation happened only through a clinician\'s entry in the visit', () => {
    const consult = charge({ category: 'consultation', encounterId: 'encounter:one' });
    assert.equal(serviceFulfillment(consult, { ...none, visitEntries: [entry('e:amend', 'amendment', { note: 'x' }, 'doctor', { amends: 'e:old' })] }).kind, 'missing');
    assert.equal(serviceFulfillment(consult, { ...none, visitEntries: [entry('e:dx', 'diagnosis', { diagnosis: 'Malaria' })] }).kind, 'visit');
  });
  it('treats registration and card fees as administrative, and a clinician\'s "not done" always wins', () => {
    assert.equal(serviceFulfillment(charge({ category: 'registration' }), none).kind, 'administrative');
    assert.equal(serviceFulfillment(charge({}), { ...none, completion: completion('c:1', 'completed') }).kind, 'completion');
    assert.equal(serviceFulfillment(charge({ category: 'registration' }), { ...none, completion: completion('c:1', 'not_done') }).kind, 'not_done');
  });
  it('follows corrections to the latest completion, and requires a reason for not done', () => {
    const current = currentCompletions([completion('c:1', 'not_done'), completion('c:2', 'completed', { replaces: 'c:1', createdOn: '2026-03-10T11:00:00.000Z' })]);
    assert.equal(current.get('charge:one')?.id, 'c:2');
    assert.throws(() => ServiceCompletion.parse({ ...base, id: 'c:3', type: 'service_completion', patientId: PATIENT, chargeId: 'charge:one', status: 'not_done', completedOn: base.createdOn, actorRole: 'nurse' }));
  });
});

describe('billing periods', () => {
  const periods = [{ from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' }, { from: '2026-06-01T00:00:00.000Z' }];
  it('judges a charge by when it was raised: inside a period, not before, between or never', () => {
    assert.equal(inBillingPeriod('2026-02-28T23:59:59.000Z', periods), false, 'before activation');
    assert.equal(inBillingPeriod('2026-03-15T00:00:00.000Z', periods), true);
    assert.equal(inBillingPeriod('2026-04-01T00:00:00.000Z', periods), false, 'the end is exclusive');
    assert.equal(inBillingPeriod('2026-05-01T00:00:00.000Z', periods), false, 'while billing was off');
    assert.equal(inBillingPeriod('2027-01-01T00:00:00.000Z', periods), true, 'an open period');
    assert.equal(inBillingPeriod('not a date', periods), false);
    assert.equal(inBillingPeriod('2026-03-15T00:00:00.000Z', []), false);
  });
});
