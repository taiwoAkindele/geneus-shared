import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Disposition, InvestigationItem, InvestigationReview, UploadRequest, careEntryIssues, closesEncounter, dispositionHeads, type EncounterEntry } from '../src/index.ts';
const source = (id: string, step: EncounterEntry['step'], values: Record<string, unknown>): EncounterEntry => ({ id, type: 'encounter_entry', facilityId: 'A', deviceId: 'device:A', createdBy: 'staff:A', createdOn: '2026-10-30T09:00:00Z', schemaVersion: 4, workflowVersion: 1, patientId: 'A-000001-K2', encounterId: 'encounter:A', actorRole: 'doctor', step, values });
describe('independent clinical workflow contract', () => {
  it('distinguishes a signed no-test decision from an order and from missing review', () => {
    assert.equal(InvestigationReview.safeParse({ decision: 'none_required' }).success, true);
    assert.equal(InvestigationReview.safeParse({ decision: 'ordered' }).success, false);
    assert.equal(InvestigationReview.safeParse({ decision: 'none_required', orderEntryId: 'order:A' }).success, false);
    assert.equal(careEntryIssues(source('entry:discharge', 'disposition', { kind: 'home_care', note: 'Advice' }), []).length > 0, true);
  });
  it('requires clinical handover details and does not close observation', () => {
    assert.equal(Disposition.safeParse({ kind: 'referral', note: 'Refer' }).success, false);
    assert.equal(Disposition.safeParse({ kind: 'admission', note: 'Request' }).success, false);
    assert.equal(Disposition.safeParse({ kind: 'observation', note: 'Observe', responsibleService: 'Team A', reassessOn: '2026-10-30T12:00:00Z' }).success, true);
    assert.equal(closesEncounter(source('entry:observation', 'disposition', { kind: 'observation' })), false);
    assert.equal(closesEncounter(source('entry:home', 'disposition', { kind: 'home_care' })), true);
  });
  it('uses predecessor identity rather than device time for disposition transitions', () => {
    const first = source('entry:first', 'disposition', { kind: 'observation' });
    const next = source('entry:next', 'disposition', { kind: 'observation', previousEntryId: first.id });
    assert.deepEqual(dispositionHeads([next, first]).map((e) => e.id), [next.id]);
    const fork = source('entry:fork', 'disposition', { kind: 'observation', previousEntryId: first.id });
    const prerequisites = [source('dx', 'diagnosis', { diagnosis: 'Assessment' }), source('review', 'investigation_review', { decision: 'none_required' })];
    assert.match(careEntryIssues(source('entry:new', 'disposition', { kind: 'home_care', previousEntryId: next.id }), [...prerequisites, first, next, fork])[0], /Competing dispositions/);
  });
  it('requires stable catalogue identities and coherent price snapshots', () => {
    assert.equal(InvestigationItem.safeParse({ id: 'item:A', name: 'Test' }).success, false);
    assert.equal(InvestigationItem.safeParse({ id: 'item:A', name: 'Unlisted', custom: true }).success, true);
    assert.equal(InvestigationItem.safeParse({ id: 'item:A', name: 'Test', offeringId: 'offering:A', serviceDefinitionId: 'definition:A', priceMinor: 100 }).success, false);
  });
  it('requires negotiation before accepting new clinical values', () => {
    const record = source('entry:review', 'investigation_review', { decision: 'none_required' });
    const request = { transactionId: 1, mutations: [{ clientId: 1, op: 'put', table: 'encounter_entry', id: record.id, data: record }] };
    assert.equal(UploadRequest.safeParse(request).success, false);
    assert.equal(UploadRequest.safeParse({ ...request, clinicalWorkflowVersion: 1 }).success, false);
    assert.equal(UploadRequest.safeParse({ ...request, clinicalWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 4, policyVersion: 10 }).success, true);
  });
});
