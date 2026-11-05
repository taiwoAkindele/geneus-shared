import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Encounter, EncounterEntry, InpatientEvent, WardCareEvent, wardSessionIssues, wardEntryIssues, wardEventIssues, wardReadinessIssues, medicationHeads, dischargeHeads, clinicalRecordActions, visitRegisterRows, type WardRecords } from '../src/index.ts';

const base = { facilityId: 'TEST', deviceId: 'device:one', createdBy: 'staff:one', createdOn: '2026-11-04T10:00:00Z' };
const admission = InpatientEvent.parse({ ...base, id: 'stay:one', type: 'inpatient_event', admissionId: 'stay:one', patientId: 'TEST-000001-K2', encounterId: 'visit:source', requestEntryId: 'request:one', action: 'confirm', receivingUnitId: 'unit:ward', actorRole: 'doctor' });
const session = Encounter.parse({ ...base, id: 'visit:review', type: 'encounter', workflowVersion: 1, patientId: admission.patientId, openedOn: base.createdOn, inpatientContext: { admissionId: admission.id, purpose: 'review' } });
const entry = (step: string, values: Record<string, unknown>, id = 'entry:' + step) => EncounterEntry.parse({ ...base, type: 'encounter_entry', id, patientId: admission.patientId, encounterId: session.id, admissionId: admission.id, step, values, actorRole: 'doctor' });
const prescription = entry('prescription', { decision: 'prescribed', prescription: [{ lineId: 'line:one', drug: 'Synthetic medicine', dose: 'Recorded dose', route: 'Oral' }] });
const event = (id: string, values: Record<string, unknown>) => WardCareEvent.parse({ ...base, id, type: 'ward_care_event', admissionId: admission.id, patientId: admission.patientId, encounterId: session.id, occurredOn: '2026-11-04T10:01:00Z', values });
const order = event('order:one', { kind: 'medication', orderId: 'order:one', action: 'start', sourceEntryId: prescription.id, lineId: 'line:one' });
const records = (events: WardCareEvent[] = []): WardRecords => ({ admissions: [admission], encounters: [session], entries: [entry('complaint', { note: 'Ward review' }), prescription], events });
const summary = (id = 'summary:one', previousId?: string) => event(id, { kind: 'discharge', previousId, admissionReason: 'Recorded reason', diagnoses: 'Recorded diagnosis', course: 'Recorded care', instructions: 'Reviewed instructions', takeHome: [], sourceEntryIds: [prescription.id], patientName: 'Synthetic patient', patientIdentifier: admission.patientId, admittedOn: admission.createdOn });

describe('continuing ward care contracts', () => {
  it('links activities to the same patient/facility and refuses invented outpatient appointments', () => {
    assert.deepEqual(wardSessionIssues(session, records()), []);
    assert.ok(wardSessionIssues({ ...session, patientId: 'OTHER' }, records()).length);
    assert.ok(wardSessionIssues({ ...session, facilityId: 'OTHER' }, records()).length);
    assert.ok(wardSessionIssues({ ...session, appointmentId: 'appointment:one' }, records()).length);
  });
  it('permits notes without a fresh set of outpatient vitals and requires the entry context', () => {
    assert.deepEqual(wardEntryIssues(session, entry('complaint', { note: 'Evening nursing note' }), records()), []);
    assert.ok(wardEntryIssues(session, { ...prescription, admissionId: undefined }, records()).length);
    assert.ok(wardEntryIssues({ ...session, inpatientContext: { ...session.inpatientContext!, purpose: 'nursing' } }, prescription, records()).length);
  });
  it('keeps completed activities closed while retaining late results and amendments', () => {
    const data = records([event('done:one', { kind: 'complete' })]);
    assert.ok(wardEntryIssues(session, entry('complaint', { note: 'New work' }), data).length);
    assert.deepEqual(wardEntryIssues(session, entry('lab_results', { results: [{ test: 'Synthetic test', result: 'Recorded result' }] }), data), []);
  });
  it('requires exact signed prescription lines and a single current medication revision', () => {
    assert.deepEqual(wardEventIssues(order, records()), []);
    assert.ok(wardEventIssues(event('bad', { ...order.values, lineId: 'missing' }), records()).length);
    const continued = event('order:two', { ...order.values, action: 'continue', previousId: order.id });
    assert.deepEqual(wardEventIssues(continued, records([order])), []);
    assert.ok(wardEventIssues(event('order:race', { ...continued.values }), records([order, continued])).length);
    assert.deepEqual(medicationHeads([order, continued]).map((e) => e.id), [continued.id]);
  });
  it('does not confuse dispensing with administration, and retains dose correction history', () => {
    const given = event('dose:one', { kind: 'administration', orderEventId: order.id, dose: 'Actual dose', outcome: 'given' });
    assert.deepEqual(wardEventIssues(given, records([order])), []);
    assert.ok(wardEventIssues({ ...given, id: 'dose:duplicate' }, records([order, given])).length);
    const corrected = event('dose:correction', { ...given.values, outcome: 'not_given', reason: 'Correction after review', previousId: given.id });
    assert.deepEqual(wardEventIssues(corrected, records([order, given])), []);
    assert.equal(WardCareEvent.safeParse({ ...given, values: { ...given.values, outcome: 'not_given' } }).success, false);
    assert.deepEqual(clinicalRecordActions(given), ['administer']);
    assert.deepEqual(clinicalRecordActions(order), ['prescribe']);
  });
  it('refuses fresh administration against a changed or stopped order', () => {
    const stopped = event('order:stop', { ...order.values, action: 'stop', previousId: order.id });
    const given = event('dose:one', { kind: 'administration', orderEventId: order.id, dose: 'Actual dose', outcome: 'given' });
    assert.ok(wardEventIssues(given, records([order, stopped])).length);
  });
  it('pins summary revisions and requires the current summary or an explicit departure exception', () => {
    const dischargeSession = { ...session, inpatientContext: { ...session.inpatientContext!, purpose: 'discharge' as const } };
    const data = { ...records(), encounters: [dischargeSession] };
    const first = summary(), revised = summary('summary:two', first.id);
    assert.deepEqual(wardEventIssues(first, data), []);
    assert.deepEqual(wardEventIssues(revised, { ...data, events: [first] }), []);
    assert.ok(wardEventIssues(summary('summary:race', first.id), { ...data, events: [first, revised] }).length);
    assert.deepEqual(dischargeHeads([first, revised]).map((e) => e.id), [revised.id]);
    const readiness = { ...admission, action: 'ready_for_discharge' as const };
    assert.ok(wardReadinessIssues(readiness, [first], true).length);
    assert.deepEqual(wardReadinessIssues({ ...readiness, dischargeSummaryId: first.id }, [first], true), []);
    assert.deepEqual(wardReadinessIssues({ ...readiness, departureException: 'Patient left before paperwork completed' }, [], true), []);
  });
  it('keeps ended admissions closed, with a separate explicit late-review path', () => {
    const ended = { ...admission, id: 'stay:departure', previousId: admission.id, action: 'discharge' as const };
    const data = { ...records([order]), admissions: [admission, ended] };
    assert.ok(wardSessionIssues(session, data).length);
    assert.ok(wardEventIssues(event('dose:late', { kind: 'administration', orderEventId: order.id, dose: 'Recorded dose', outcome: 'given' }), data).length);
    assert.ok(wardEntryIssues({ ...session, patientId: 'OTHER' }, prescription, data, true).length);
  });
  it('excludes ward activities from automatic outpatient register rows', () => {
    const definition = { registerId: 'opd', fields: [], visitLink: { visits: 'every' as const, words: [], codes: [], visitTypes: [] } };
    assert.deepEqual(visitRegisterRows(definition, { encounters: [session], entries: [], patients: [] }), []);
  });
  it('requires explicit review of the medication state represented by a discharge summary', () => {
    const first = summary();
    assert.ok(wardReadinessIssues({ ...admission, action: 'ready_for_discharge', dischargeSummaryId: first.id }, [order, first], true).length);
    const reviewed = WardCareEvent.parse({ ...first, values: { ...first.values, sourceWardEventIds: [order.id] } });
    assert.deepEqual(wardReadinessIssues({ ...admission, action: 'ready_for_discharge', dischargeSummaryId: reviewed.id }, [order, reviewed], true), []);
  });
});
