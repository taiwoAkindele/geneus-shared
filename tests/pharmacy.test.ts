import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WardCareEvent, prescriptionLines } from '../src/index.ts';
import { EncounterEntry, Patient, StockItem, FeeItem, dispensingDetails, dispensingSummary, pharmacyEffects, pharmacyIssues, pharmacyChargeId, supplyState, supplyCharge, returnCredit, type DispensingDetails, type PharmacyRecords } from '../src/index.ts';

const base = { facilityId: 'TEST', deviceId: 'device:one', schemaVersion: 5, createdBy: 'staff:doctor', createdOn: '2026-11-08T10:00:00.000Z' };
const patient = Patient.parse({ ...base, type: 'patient', id: 'TEST-000001-K2', patientId: 'TEST-000001-K2', fullName: 'Synthetic pharmacy patient', address: 'Synthetic address', sex: 'female', ageYears: 30 });
const source = EncounterEntry.parse({ ...base, id: 'rx:one', type: 'encounter_entry', patientId: patient.id, encounterId: 'visit:one', actorRole: 'doctor', workflowVersion: 1, step: 'prescription', values: { decision: 'prescribed', prescription: [{ lineId: 'line:one', drug: 'Synthetic medicine', dose: 'Recorded instructions', quantity: 20, unitOfMeasure: 'tablets' }] } });
const item = StockItem.parse({ ...base, id: 'stock:one', type: 'stock_item', name: 'Synthetic medicine', category: 'drug', unitOfMeasure: 'tablets', quantityOnHand: 100 });
const fee = FeeItem.parse({ ...base, id: 'fee:one', type: 'fee_item', name: 'Synthetic medicine', category: 'other', chargeWhen: 'when_ordered', amountMinor: 100, currency: 'NGN' });
const data = (): PharmacyRecords => ({ entries: [source], items: [item], movements: [], fees: [fee], charges: [], adjustments: [], patient });
const details = (values: Partial<DispensingDetails> = {}): DispensingDetails => ({ prescriptionEntryId: source.id, lineId: 'line:one', action: 'supply', complete: false, quantity: 5, unit: 'tablets', source: 'stock', stockItemId: item.id, billing: 'charge', feeItemId: fee.id, unitPriceMinor: 100, currency: 'NGN', chargedMinor: 500, ...values });
const entry = (id: string, d: DispensingDetails, records = data()) => {
  const e = EncounterEntry.parse({ ...base, id, type: 'encounter_entry', patientId: patient.id, encounterId: source.encounterId, actorRole: 'doctor', workflowVersion: 1, pharmacyVersion: 1, step: 'dispense', values: { supply: d, lines: [{ drug: 'Synthetic medicine', dispensed: false, reason: 'Pending' }] } });
  e.values.lines = dispensingSummary(source, records.entries, e); return e;
};
const append = (records: PharmacyRecords, e: EncounterEntry): PharmacyRecords => {
  const effects = pharmacyEffects(e, records);
  return { ...records, entries: [...records.entries, e], movements: [...records.movements, ...effects.filter((r) => r.type === 'stock_movement')], charges: [...records.charges, ...effects.filter((r) => r.type === 'charge')], adjustments: [...records.adjustments, ...effects.filter((r) => r.type === 'billing_adjustment')] };
};
describe('quantity-based pharmacy contract', () => {
  it('supplies the exact signed take-home prescription and refuses new supplies against a revised summary', () => {
    const summary = WardCareEvent.parse({ ...base, id: 'summary:one', type: 'ward_care_event', admissionId: 'stay:one', patientId: patient.id, encounterId: source.encounterId, occurredOn: base.createdOn, values: { kind: 'discharge', admissionReason: 'Recorded reason', diagnoses: 'Recorded diagnosis', course: 'Recorded care', instructions: 'Reviewed instructions', takeHome: source.values.prescription, sourceEntryIds: [], patientName: patient.fullName, patientIdentifier: patient.id, admittedOn: base.createdOn } });
    const records = { ...data(), entries: [], wardEvents: [summary] };
    const supply = entry('take-home:supply', details({ prescriptionEntryId: summary.id, lineId: prescriptionLines(summary)[0].lineId }));
    supply.values.lines = dispensingSummary(summary, [], supply);
    assert.deepEqual(pharmacyIssues(supply, records), []);
    assert.equal(pharmacyEffects(supply, records).length, 2);
    const revised = WardCareEvent.parse({ ...summary, id: 'summary:revised', values: { ...summary.values, previousId: summary.id } });
    assert.match(pharmacyIssues(supply, { ...records, wardEvents: [summary, revised] }).join(), /revised/);
  });
  it('retains partial supplies and derives a stock movement and bill for only the quantity handed over', () => {
    const first = entry('supply:one', details()); assert.deepEqual(pharmacyIssues(first, data()), []);
    const saved = append(data(), first), state = supplyState(source, 'line:one', saved.entries);
    assert.equal(state.supplied, 5); assert.equal(state.complete, false); assert.equal(saved.movements[0].change, -5); assert.equal(saved.charges[0].amountMinor, 500);
    const last = entry('supply:two', details({ quantity: 15, chargedMinor: 1500, complete: true, previousEntryId: first.id }), saved);
    assert.deepEqual(pharmacyIssues(last, saved), []); assert.equal(supplyState(source, 'line:one', append(saved, last).entries).supplied, 20);
  });
  it('refuses stale predecessors, over-supply, guessed pack conversions and false completion', () => {
    const first = entry('supply:one', details()), saved = append(data(), first);
    assert.ok(pharmacyIssues(entry('stale', details()), saved).length);
    assert.ok(pharmacyIssues(entry('too-many', details({ quantity: 21, chargedMinor: 2100, complete: true })), data()).length);
    assert.ok(pharmacyIssues(entry('packs', details({ unit: 'packs' })), data()).length);
    assert.ok(pharmacyIssues(entry('early-complete', details({ complete: true })), data()).length);
  });
  it('keeps source identity and original clinical instructions immutable', () => {
    assert.ok(pharmacyIssues(entry('wrong-line', details({ lineId: 'line:other' })), data()).length);
    const correction = EncounterEntry.parse({ ...base, id: 'amend:rx', type: 'encounter_entry', patientId: patient.id, encounterId: source.encounterId, actorRole: 'doctor', step: 'amendment', amends: source.id, values: { note: 'Source corrected', correctedValues: { decision: 'none_required', prescription: [] } } });
    assert.ok(pharmacyIssues(entry('corrected-rx', details()), { ...data(), entries: [source, correction] }).length);
    assert.equal(source.values.prescription && (source.values.prescription as { quantity: number }[])[0].quantity, 20);
  });
  it('records outside supplies without a stock movement or hospital medicine bill', () => {
    const outside = entry('outside', details({ source: 'outside', stockItemId: undefined, billing: 'outside', feeItemId: undefined, unitPriceMinor: undefined, currency: undefined, chargedMinor: undefined }));
    assert.deepEqual(pharmacyIssues(outside, data()), []); assert.deepEqual(pharmacyEffects(outside, data()), []);
  });
  it('bills an unpriced saved supply once without deducting stock again', () => {
    const first = entry('unpriced', details({ source: 'untracked', stockItemId: undefined, billing: 'unpriced', feeItemId: undefined, unitPriceMinor: undefined, currency: undefined, chargedMinor: undefined, reason: 'Selling price not set' }));
    const saved = append(data(), first);
    const priced = entry('priced', { prescriptionEntryId: source.id, lineId: 'line:one', previousEntryId: first.id, action: 'price', priceFor: first.id, complete: false, quantity: 5, unit: 'tablets', billing: 'charge', feeItemId: fee.id, unitPriceMinor: 100, currency: 'NGN', chargedMinor: 500 }, saved);
    assert.deepEqual(pharmacyIssues(priced, saved), []); const final = append(saved, priced);
    assert.equal(final.movements.length, 0); assert.equal(supplyCharge(first.id, final)?.amountMinor, 500);
    assert.ok(pharmacyIssues(entry('priced-twice', { ...dispensingDetails(priced)!, previousEntryId: priced.id }, final), final).length);
  });
  it('caps returns to the actual supply and credits the original bill', () => {
    const first = entry('supply', details()), saved = append(data(), first);
    const returned = entry('return', { prescriptionEntryId: source.id, lineId: 'line:one', previousEntryId: first.id, action: 'return', returnOf: first.id, quantity: 2, unit: 'tablets', restock: true, creditMinor: 200, complete: false, reason: 'Recorded medicine return' }, saved);
    assert.deepEqual(pharmacyIssues(returned, saved), []); const final = append(saved, returned);
    assert.equal(final.movements[1].change, 2); assert.equal(final.adjustments[0].chargeId, pharmacyChargeId(first.id)); assert.equal(supplyState(source, 'line:one', final.entries).supplied, 3);
    assert.ok(pharmacyIssues(entry('too-large-return', { ...dispensingDetails(returned)!, previousEntryId: returned.id, quantity: 4, creditMinor: 300 }, final), final).length);
    assert.equal(returnCredit(first, 10, { ...saved, adjustments: [{ ...final.adjustments[0], amountMinor: 450 }] }), 50);
  });
});
