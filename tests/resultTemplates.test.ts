import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AssignablePermission, EncounterEntry, NumberPart, ROLE_PERMISSIONS, ResultTemplate, ResultTemplateDraft, TEXT_RESULT_PART, UploadRequest,
  hasCriticalFlag, labItemSummary, labPatientFacts, labReportIssues, parseDocument, rangeFor, templateForTest, templateResultType,
  type LabReport, type LabReportContext, type ResultPart,
} from '../src/index.ts';

const adult = { value: 18, unit: 'years' } as const;
const haemoglobin = NumberPart.parse({ key: 'hb', label: 'Haemoglobin', kind: 'number', unit: 'g/dL', decimals: 1, required: true, ranges: [
  { sex: 'female', ageFrom: adult, low: 12, high: 15 }, { sex: 'male', ageFrom: adult, low: 13, high: 17 },
] });
const parts: ResultPart[] = [haemoglobin, { key: 'film', label: 'Film comment', kind: 'text', required: false }];
const template = ResultTemplate.parse({
  id: 'result_template:fbc', type: 'result_template', facilityId: 'A', deviceId: 'server', createdBy: 'staff:A', createdOn: '2026-11-01T09:00:00Z',
  name: 'Full blood count', status: 'active', parts, serviceDefinitionIds: ['service_definition:fbc'], source: 'standard', standardKey: 'fbc', revision: 2,
});
const woman = labPatientFacts({ sex: 'female', dateOfBirth: '1992-05-10', createdOn: '2026-01-01T00:00:00Z' }, '2026-11-02T10:00:00Z');
const context = (facts = woman): LabReportContext => ({
  facts, template: (id, revision) => id === template.id && revision === 2 ? template : undefined,
  serviceDefinitionFor: (orderItemId) => orderItemId === 'item:fbc' ? 'service_definition:fbc' : undefined,
});
const report = (hb: number, extra: Partial<LabReport['items'][number]> = {}): LabReport => ({ patient: woman, items: [{
  test: 'Full blood count', orderItemId: 'item:fbc', template: { id: template.id, revision: 2 },
  values: [{ kind: 'number', key: 'hb', value: hb, range: rangeFor(haemoglobin, woman), flag: 'low' }], ...extra,
}] });
const rows = (r: LabReport) => r.items.map((item) => ({ test: item.test, orderItemId: item.orderItemId, result: labItemSummary(item, item.template ? template.parts : [TEXT_RESULT_PART]) }));

describe('normal ranges', () => {
  it('chooses the range for the patient’s sex and age, and none when a fact is missing', () => {
    assert.deepEqual(rangeFor(haemoglobin, woman), { sex: 'female', ageFrom: adult, low: 12, high: 15 });
    assert.equal(rangeFor(haemoglobin, labPatientFacts({ sex: 'male', ageYears: 40, ageObservedOn: '2026-01-01', createdOn: '2026-01-01T00:00:00Z' }, '2026-11-02'))?.low, 13);
    assert.equal(rangeFor(haemoglobin, { age: { years: 34 } }), undefined, 'sex not recorded');
    assert.equal(rangeFor(haemoglobin, { sex: 'female' }), undefined, 'age not recorded');
    assert.equal(rangeFor(haemoglobin, { sex: 'female', age: { years: 10 } }), undefined, 'no children’s range set');
  });
  it('matches day and month bands only when a date of birth is known', () => {
    const infant = NumberPart.parse({ key: 'wbc', label: 'White cells', kind: 'number', ranges: [{ ageTo: { value: 1, unit: 'months' }, low: 9, high: 30 }] });
    const newborn = labPatientFacts({ dateOfBirth: '2026-10-20', createdOn: '2026-10-20T00:00:00Z' }, '2026-11-02');
    assert.deepEqual(newborn, { age: { years: 0, months: 0, days: 13 } });
    assert.equal(rangeFor(infant, newborn)?.low, 9);
    assert.equal(rangeFor(infant, { age: { years: 0 } }), undefined);
  });
  it('refuses rows that cover the same patients, across age units', () => {
    const anyone = { low: 1, high: 2 };
    assert.equal(NumberPart.safeParse({ key: 'x', label: 'X', kind: 'number', ranges: [anyone, { sex: 'female', ageFrom: adult, low: 1, high: 3 }] }).success, false);
    assert.equal(NumberPart.safeParse({ key: 'x', label: 'X', kind: 'number', ranges: [{ ageTo: { value: 12, unit: 'months' }, ...anyone }, { ageFrom: { value: 1, unit: 'years' }, ...anyone }] }).success, true);
    assert.equal(NumberPart.safeParse({ key: 'x', label: 'X', kind: 'number', ranges: [{ low: 5, high: 4 }] }).success, false);
  });
});

describe('result templates', () => {
  it('needs distinct part keys and links tests only while in use', () => {
    assert.equal(ResultTemplateDraft.safeParse({ name: 'FBC', status: 'active', parts: [haemoglobin, haemoglobin], serviceDefinitionIds: [] }).success, false);
    assert.equal(ResultTemplateDraft.safeParse({ name: 'FBC', status: 'draft', parts, serviceDefinitionIds: ['service_definition:fbc'] }).success, false);
    assert.equal(parseDocument(template).success, true);
    assert.equal(templateForTest([template], 'service_definition:fbc')?.id, template.id);
    assert.equal(templateForTest([{ ...template, status: 'archived' }], 'service_definition:fbc'), undefined);
    assert.equal(templateResultType(parts), 'Mixed');
    assert.equal(templateResultType([haemoglobin]), 'Numbers');
  });
  it('is managed by administrators and can be assigned to lab staff', () => {
    assert.ok(ROLE_PERMISSIONS.facility_admin.includes('result_template:manage'));
    assert.ok(!ROLE_PERMISSIONS.laboratory_staff.includes('result_template:manage'));
    assert.ok(AssignablePermission.options.includes('result_template:manage'));
  });
});

describe('structured lab results', () => {
  it('accepts a result entered against its template, with the patient’s range and an optional flag', () => {
    const r = report(10.8);
    assert.deepEqual(labReportIssues(rows(r), r, context()), []);
    assert.equal(rows(r)[0].result, 'Haemoglobin 10.8 g/dL (Low)');
  });
  it('refuses a range that is not the patient’s, a stale summary, or changed patient facts', () => {
    const wrong = report(10.8); (wrong.items[0].values[0] as { range?: unknown }).range = { sex: 'male', ageFrom: adult, low: 13, high: 17 };
    assert.match(labReportIssues(rows(wrong), wrong, context())[0], /normal range/);
    const r = report(10.8);
    assert.match(labReportIssues([{ ...rows(r)[0], result: 'Haemoglobin 9.0 g/dL' }], r, context())[0], /summary/);
    assert.match(labReportIssues(rows(r), r, context({ sex: 'male', age: woman.age }))[0], /sex or age/);
    const precise = report(10.85);
    assert.match(labReportIssues(rows(precise), precise, context())[0], /decimal/);
  });
  it('refuses parts the template lacks, missing required parts, and a template not in use for the test', () => {
    const extra = report(10.8, { values: [{ kind: 'number', key: 'hb', value: 10.8, range: rangeFor(haemoglobin, woman) }, { kind: 'text', key: 'other', text: 'x' }] });
    assert.match(labReportIssues(rows(extra), extra, context())[0], /not part of this template/);
    const missing = report(10.8, { values: [{ kind: 'text', key: 'film', text: 'Normocytic' }] });
    assert.match(labReportIssues(rows(missing), missing, context())[0], /Haemoglobin is required/);
    const unlisted = report(10.8, { orderItemId: 'item:custom' });
    assert.match(labReportIssues(rows(unlisted), unlisted, context())[0], /not in use for this test/);
    const missingVersion = report(10.8, { template: { id: template.id, revision: 1 } });
    assert.match(labReportIssues(rows(missingVersion), missingVersion, context())[0], /version is not available/);
  });
  it('keeps a test with no template as one free-text result', () => {
    const plain: LabReport = { patient: woman, items: [{ test: 'Synthetic test', values: [{ kind: 'text', key: 'result', text: 'Negative' }] }] };
    assert.deepEqual(labReportIssues(rows(plain), plain, context()), []);
    assert.equal(rows(plain)[0].result, 'Negative');
  });
  it('detects a critical flag for the clinician’s alert', () => {
    assert.equal(hasCriticalFlag(report(10.8)), false);
    const critical = report(5.1); (critical.items[0].values[0] as { flag?: string }).flag = 'critically_low';
    assert.equal(hasCriticalFlag(critical), true);
  });
  it('belongs only on a lab result entry, and needs the result template workflow to upload', () => {
    const r = report(10.8);
    const entry = { id: 'entry:lr', type: 'encounter_entry', facilityId: 'A', deviceId: 'device:A', createdBy: 'staff:A', createdOn: '2026-11-02T10:00:00Z', schemaVersion: 5, workflowVersion: 1, patientId: 'A-000001-K2', encounterId: 'encounter:A', actorRole: 'laboratory_staff', step: 'lab_results', values: { results: rows(r) }, labReport: r };
    assert.equal(EncounterEntry.safeParse(entry).success, true);
    assert.equal(EncounterEntry.safeParse({ ...entry, step: 'vitals', values: { temperature: 37 } }).success, false);
    const mutation = { clientId: 1, op: 'put', table: 'encounter_entry', id: entry.id, data: entry };
    const base = { transactionId: 1, clinicalWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: 13, mutations: [mutation] };
    assert.equal(UploadRequest.safeParse(base).success, false);
    assert.equal(UploadRequest.safeParse({ ...base, resultTemplateWorkflowVersion: 1 }).success, true);
  });
});
