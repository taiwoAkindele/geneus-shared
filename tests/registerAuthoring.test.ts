import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RegisterDefinition } from '../src/documents.ts';
import { registerDefinitionIssues } from '../src/registers.ts';
const draft = RegisterDefinition.parse({ id: 'daily:v1', type: 'register_definition', registerId: 'daily', version: 1, facilityId: 'TEST', deviceId: 'device:one', createdBy: 'staff:one', createdOn: '2026-10-26T10:00:00Z', name: 'Daily', category: 'General', status: 'draft', fields: [] });
describe('register authoring invariants', () => {
  it('allows named empty drafts and requires real questions and distinct choices for publication', () => {
    assert.deepEqual(registerDefinitionIssues(draft), []);
    assert.ok(registerDefinitionIssues({ ...draft, status: 'published' }).length);
    assert.ok(registerDefinitionIssues({ ...draft, status: 'published', fields: [{ id: 'choice', type: 'select', label: 'Result', required: true, options: ['Positive', 'positive'] }] }).some((issue) => issue.includes('duplicate choices')));
  });
  it('never reuses published field identities for different types or retired questions', () => {
    const original = { ...draft, status: 'published' as const, fields: [{ id: 'name', type: 'text' as const, label: 'Name', required: false }] };
    assert.ok(registerDefinitionIssues({ ...original, fields: [{ ...original.fields[0], type: 'number' }] }, [original]).some((issue) => issue.includes('changed type')));
    const later = { ...original, version: 2, fields: [{ id: 'other', type: 'text' as const, label: 'Other', required: false }] };
    assert.ok(registerDefinitionIssues(original, [original, later]).some((issue) => issue.includes('removed field identity')));
    assert.deepEqual(registerDefinitionIssues(original, [original, { ...draft, version: 2 }]), []);
  });
});
