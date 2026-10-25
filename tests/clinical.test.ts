import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLINICAL_VALUES, ClinicalEvent, currentAllergies, currentClinicalEvents, effectiveEncounterEntries, unreviewedLegacyAllergies, type EncounterEntry } from '../src/index.ts';

const event = (id: string, previousId?: string) => ClinicalEvent.parse({
  id, previousId, recordId: 'clinical:problem', type: 'clinical_event', patientId: 'OOE-PHC-000047-K2',
  facilityId: 'OOE-PHC', deviceId: 'device:one', createdBy: 'staff:doctor', createdOn: '2026-10-25T09:00:00Z', actorRole: 'doctor',
  kind: 'problem', values: { label: 'Hypertension', status: 'active', certainty: 'confirmed' },
});
describe('longitudinal clinical contract', () => {
  it('selects a causal revision even when the device clock goes backwards', () => {
    const first = event('first');
    const second = { ...event('second', first.id), createdOn: '2026-10-24T09:00:00Z' };
    assert.deepEqual(currentClinicalEvents([second, first]), [second]);
  });
  it('keeps competing offline revisions visible for reconciliation', () => {
    const first = event('first');
    assert.equal(currentClinicalEvents([first, event('second', first.id), event('third', first.id)]).length, 2);
  });
  it('rejects invalid dates, empty history, and medication stop dates before start', () => {
    assert.equal(CLINICAL_VALUES.history.safeParse({}).success, false);
    assert.equal(CLINICAL_VALUES.problem.safeParse({ label: 'Condition', status: 'active', certainty: 'confirmed', onsetOn: '2026-02-30' }).success, false);
    assert.equal(CLINICAL_VALUES.medication.safeParse({ drug: 'Medication', dose: '1', frequency: 'daily', status: 'stopped', startedOn: '2026-10-25', stoppedOn: '2026-10-24' }).success, false);
  });
  it('rejects values for the wrong kind and self-referencing versions', () => {
    assert.equal(ClinicalEvent.safeParse({ ...event('a'), kind: 'allergy' }).success, false);
    assert.equal(ClinicalEvent.safeParse({ ...event('a'), previousId: 'a' }).success, false);
  });
  it('applies structured corrections causally without mutating the original', () => {
    const original: EncounterEntry = { ...event('entry'), type: 'encounter_entry', encounterId: 'encounter:one', step: 'vitals', values: { temperatureC: 39 } };
    const correction: EncounterEntry = { ...original, id: 'correction', step: 'amendment', amends: original.id, values: { note: 'Correct reading', correctedValues: { temperatureC: 38 } } };
    const latest: EncounterEntry = { ...correction, id: 'latest', createdOn: '2026-10-24T09:00:00Z', values: { note: 'Checked source', correctedValues: { temperatureC: 37 }, previousAmendmentId: correction.id } };
    assert.equal(effectiveEncounterEntries([original, correction, latest])[0].values.temperatureC, 37);
    assert.equal(original.values.temperatureC, 39);
  });
  it('retains legacy allergies until reviewed, and respects a structured refutation without rewriting demographics', () => {
    const patient = { patientId: 'OOE-PHC-000047-K2', allergies: ['Penicillin', 'Sulfa'] };
    const reviewed = ClinicalEvent.parse({ ...event('allergy'), kind: 'allergy', values: { allergen: 'penicillin', reaction: 'No reaction confirmed', severity: 'unknown', verification: 'refuted', status: 'inactive' } });
    assert.equal(currentAllergies([], [patient]).length, 2);
    assert.deepEqual(currentAllergies([reviewed], [patient]).map((allergy) => allergy.allergen), ['Sulfa']);
    assert.deepEqual(unreviewedLegacyAllergies([reviewed], [patient]), [{ patientId: patient.patientId, allergen: 'Sulfa' }]);
    assert.deepEqual(patient.allergies, ['Penicillin', 'Sulfa']);
  });
});
