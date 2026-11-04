import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Encounter, EncounterEntry, Patient, RegisterDefinition, RegisterEntry, mentionsAny, registerDefinitionIssues, registerEntryLinkIssues, visitRegisterRows } from '../src/index.ts';

const envelope = { facilityId: 'A', deviceId: 'device:A', createdBy: 'staff:doctor', createdOn: '2026-11-03T09:00:00Z' };
const patient = Patient.parse({ ...envelope, id: 'A-000001-K2', type: 'patient', patientId: 'A-000001-K2', fullName: 'Amaka Okoro', sex: 'female', ageYears: 32, address: 'Odo-Ona', phone: '0801' });
const visit = (id: string, openedOn: string) => Encounter.parse({ ...envelope, id, type: 'encounter', patientId: patient.patientId, openedOn });
const entry = (id: string, encounterId: string, step: string, values: Record<string, unknown>, at = '2026-11-03T09:00:00Z', amends?: string) =>
  EncounterEntry.parse({ ...envelope, createdOn: at, id, type: 'encounter_entry', patientId: patient.patientId, encounterId, actorRole: 'doctor', step, values, ...(amends ? { amends } : {}) });
const malaria = RegisterDefinition.parse({ ...envelope, id: 'register:malaria:v1', type: 'register_definition', registerId: 'register:malaria', name: 'Malaria', category: 'Disease', status: 'published',
  visitLink: { visits: 'matching', words: ['malaria', 'RDT', 'MP'], codes: ['B50', 'B54'] },
  fields: [
    { id: 'date', type: 'text', label: 'Date', fromVisit: { fact: 'visit_date' } },
    { id: 'name', type: 'text', label: 'Name', fromVisit: { fact: 'patient_name' } },
    { id: 'rdt', type: 'text', label: 'RDT result', fromVisit: { fact: 'results', words: ['RDT'] } },
    { id: 'diagnosis', type: 'text', label: 'Diagnosis', fromVisit: { fact: 'diagnoses' } },
    { id: 'act', type: 'text', label: 'ACT given', fromVisit: { fact: 'medicines_dispensed', words: ['artemether', 'artesunate'] } },
    { id: 'outcome', type: 'text', label: 'Outcome', fromVisit: { fact: 'outcome' } },
    { id: 'onset', type: 'date', label: 'Date fever started' },
  ] });
const input = (entries: EncounterEntry[], completions: RegisterEntry[] = []) => ({ encounters: [visit('visit:1', '2026-11-03T08:30:00Z')], entries, patients: [patient], completions });

describe('visit-linked registers', () => {
  it('fills the malaria register as a general consultation goes on', () => {
    const order = entry('order', 'visit:1', 'lab_order', { tests: ['Malaria RDT'] });
    let [row] = visitRegisterRows(malaria, input([entry('complaint', 'visit:1', 'complaint', { complaints: ['Fever'] }), order]));
    assert.equal(row.values.date, '03 Nov 2026');
    assert.equal(row.values.name, 'Amaka Okoro');
    assert.equal(row.values.rdt, '', 'the test is pending');
    assert.equal(row.complete, false, 'the fever onset is still to be recorded');
    const later = [order,
      entry('result', 'visit:1', 'lab_results', { results: [{ test: 'Malaria RDT', result: 'Positive' }, { test: 'Haemoglobin', result: '11' }] }, '2026-11-03T10:00:00Z'),
      entry('dx', 'visit:1', 'diagnosis', { diagnosis: 'Malaria', prescription: [] }, '2026-11-03T10:10:00Z'),
      entry('rx', 'visit:1', 'prescription', { decision: 'prescribed', prescription: [{ drug: 'Artemether-lumefantrine', dose: '4 tablets twice daily' }, { drug: 'Paracetamol', dose: '1 g' }] }, '2026-11-03T10:11:00Z'),
      entry('given', 'visit:1', 'dispense', { lines: [{ drug: 'Artemether-lumefantrine', dispensed: true }, { drug: 'Paracetamol', dispensed: true }] }, '2026-11-03T10:30:00Z'),
      entry('home', 'visit:1', 'disposition', { kind: 'home_care', note: 'Advice given' }, '2026-11-03T10:31:00Z')];
    const completion = RegisterEntry.parse({ ...envelope, id: 'complete:1', type: 'register_entry', registerId: 'register:malaria', registerVersion: 1, entryDate: '2026-11-03', patientId: patient.patientId, encounterId: 'visit:1', values: { onset: '2026-11-01' } });
    [row] = visitRegisterRows(malaria, input(later, [completion]));
    assert.deepEqual([row.values.rdt, row.values.diagnosis, row.values.act, row.values.outcome, row.values.onset], ['Malaria RDT: Positive', 'Malaria', 'Artemether-lumefantrine', 'Sent home', '2026-11-01']);
    assert.equal(row.complete, true);
  });
  it('takes only matching visits, by word or diagnosis code, without matching inside words', () => {
    assert.deepEqual(visitRegisterRows(malaria, input([entry('dx', 'visit:1', 'diagnosis', { diagnosis: 'Breast lump', prescription: [] })])), []);
    assert.equal(visitRegisterRows(malaria, input([entry('dx', 'visit:1', 'diagnosis', { diagnosis: 'Fever', diagnoses: [{ label: 'Fever', code: 'B54', codingSystem: 'ICD-10' }], prescription: [] })])).length, 1);
    assert.equal(mentionsAny('Malarial fever', ['malaria']), true);
    assert.equal(mentionsAny('MP test', ['MP']), true);
    assert.equal(mentionsAny('lump', ['MP']), false);
  });
  it('reads a corrected diagnosis, tells new visits from revisits and keeps the latest completion', () => {
    const opd = RegisterDefinition.parse({ ...malaria, id: 'register:opd:v1', registerId: 'register:opd', visitLink: { visits: 'every' }, fields: [{ id: 'kind', type: 'text', label: 'New or revisit', fromVisit: { fact: 'new_or_revisit' } }, { id: 'dx', type: 'text', label: 'Diagnosis', fromVisit: { fact: 'diagnoses' } }, { id: 'note', type: 'text', label: 'Note' }] });
    const dx = entry('dx', 'visit:2', 'diagnosis', { diagnosis: 'Malaria', prescription: [] });
    const fix = entry('fix', 'visit:2', 'amendment', { note: 'Typo', correctedValues: { diagnosis: 'Typhoid', prescription: [] } }, '2026-11-03T11:00:00Z', 'dx');
    const note = (id: string, text: string, at: string) => RegisterEntry.parse({ ...envelope, createdOn: at, id, type: 'register_entry', registerId: 'register:opd', registerVersion: 1, entryDate: '2026-11-03', patientId: patient.patientId, encounterId: 'visit:2', values: { note: text } });
    const rows = visitRegisterRows(opd, { encounters: [visit('visit:1', '2026-10-01T08:00:00Z'), visit('visit:2', '2026-11-03T08:00:00Z')], entries: [dx, fix], patients: [patient], completions: [note('n2', 'second', '2026-11-03T12:00:00Z'), note('n1', 'first', '2026-11-03T11:30:00Z')] });
    assert.deepEqual(rows.map((row) => [row.encounterId, row.values.kind, row.values.dx, row.values.note ?? '']), [['visit:2', 'Revisit', 'Typhoid', 'second'], ['visit:1', 'New', '', '']]);
  });
  it('keeps visit-filled fields out of staff entries and authoring', () => {
    assert.ok(registerDefinitionIssues({ ...malaria, visitLink: undefined }).some((issue) => issue.includes('Choose which visits')));
    assert.ok(registerDefinitionIssues({ ...malaria, visitLink: { visits: 'matching', words: [], codes: [] } }).some((issue) => issue.includes('words or diagnosis codes')));
    assert.ok(registerDefinitionIssues({ ...malaria, fields: [{ id: 'x', type: 'number', label: 'Age', required: false, fromVisit: { fact: 'age' } }] }).some((issue) => issue.includes('short text')));
    assert.deepEqual(registerDefinitionIssues(malaria), []);
    assert.ok(registerEntryLinkIssues(malaria, { values: { onset: '2026-11-01' } }).length);
    assert.ok(registerEntryLinkIssues(malaria, { encounterId: 'visit:1', patientId: patient.patientId, values: { rdt: 'Positive' } }).some((issue) => issue.includes('not recorded by staff')));
    assert.deepEqual(registerEntryLinkIssues(malaria, { encounterId: 'visit:1', patientId: patient.patientId, values: { onset: '2026-11-01' } }), []);
    assert.ok(registerEntryLinkIssues({ fields: [], visitLink: undefined }, { encounterId: 'visit:1', values: {} }).length);
  });
  it("takes visits of chosen types, reading an older visit's type from its appointment", () => {
    const anc = RegisterDefinition.parse({ ...malaria, id: 'register:anc:v1', registerId: 'register:anc', name: 'Antenatal', visitLink: { visits: 'visit_types', visitTypes: ['antenatal'] },
      fields: [{ id: 'type', type: 'text', label: 'Visit', fromVisit: { fact: 'visit_type' } }, { id: 'td', type: 'text', label: 'Td', fromVisit: { fact: 'injections', words: ['Td', 'tetanus'] } }, { id: 'ga', type: 'number', label: 'Gestational age (weeks)' }] });
    const typed = Encounter.parse({ ...visit('visit:anc', '2026-11-03T08:00:00Z'), visitType: 'antenatal' });
    const booked = Encounter.parse({ ...visit('visit:booked', '2026-11-02T08:00:00Z'), appointmentId: 'appointment:1' });
    const general = visit('visit:general', '2026-11-01T08:00:00Z');
    const td = entry('td', 'visit:anc', 'injection', { drug: 'Td', dose: '0.5 mL', route: 'IM' });
    const rows = visitRegisterRows(anc, { encounters: [typed, booked, general], entries: [td], patients: [patient], appointments: [{ id: 'appointment:1', visitType: 'antenatal' }] });
    assert.deepEqual(rows.map((row) => [row.encounterId, row.values.type, row.values.td]), [['visit:anc', 'Antenatal', 'Td 0.5 mL'], ['visit:booked', 'Antenatal', '']]);
    assert.ok(registerDefinitionIssues({ ...anc, visitLink: { visits: 'visit_types', words: [], codes: [], visitTypes: [] } }).some((issue) => issue.includes('visit types')));
    assert.deepEqual(registerDefinitionIssues(anc), []);
  });
});
