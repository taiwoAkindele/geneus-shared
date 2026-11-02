import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FacilityWorkforcePolicy, SyncRejection, SyncTokenResponse, UploadRequest, UploadResponse,
  configurationRevisionIssues, facilityCompatibilityIssues, facilityMutationIssues, requiresFacilityContract,
  workforceEnforcementActive, type FacilityMutation } from '../src/index.ts';
import { NOW, assignment, envelope, location } from './facilityFixtures.ts';

const support = { contractVersion: 1, minimumSchemaVersion: 4, minimumPolicyVersion: 10 } as const;
const versions = { facilityContractVersion: 1, schemaVersion: 4, policyVersion: 10 } as const;
const mutation = { clientId: 1, table: 'location', id: location.id, op: 'put', data: location } as const;

describe('facility compatibility and synchronized mutations', () => {
  it('retains legacy API contracts but requires a feature/schema/policy handshake for new records', () => {
    const legacy = { transactionId: null, mutations: [{ ...mutation, table: 'unit', data: { name: 'Legacy unit' } }] };
    assert.equal(UploadRequest.safeParse(legacy).success, true);
    assert.equal(UploadRequest.safeParse({ transactionId: 1, mutations: [mutation] }).success, false);
    const request = UploadRequest.parse({ ...versions, transactionId: 1, mutations: [mutation] });
    assert.deepEqual(facilityCompatibilityIssues(request, support), []);
    assert.ok(facilityCompatibilityIssues(request, undefined).length);
    assert.ok(facilityCompatibilityIssues({ ...request, policyVersion: 9 }, support).length);
    assert.deepEqual(facilityCompatibilityIssues({ ...request, policyVersion: 11 }, support), []);
    assert.ok(facilityCompatibilityIssues({ ...request, policyVersion: 14 }, support).length);
    assert.deepEqual(facilityCompatibilityIssues({ ...request, schemaVersion: 5 }, support), []);
    assert.ok(facilityCompatibilityIssues({ ...request, schemaVersion: 6 }, support).length);
    assert.ok(facilityCompatibilityIssues(legacy, support, true).length);
    assert.deepEqual(facilityCompatibilityIssues(legacy, undefined), []);
    const response = { token: 'synthetic', expiresOn: '2026-10-30T00:00:00Z', syncEndpoint: 'https://sync.example.org', serverTime: envelope.createdOn };
    assert.equal(SyncTokenResponse.safeParse(response).success, true);
    assert.equal(SyncTokenResponse.safeParse({ ...response, facilityFeature: support }).success, true);
  });
  it('detects privileged optional fields and new duty roles on old record types, including explicit clears', () => {
    for (const [table, data] of [
      ['unit', { parentId: null }], ['appointment', { allocation: null }], ['billing_department', { organizationUnitId: null }],
      ['staff', { additionalRoles: ['laboratory_staff'] }], ['staff', { additionalPermissions: ['clinical:prescribe'] }],
      ['encounter_entry', { actorContext: {} }], ['facility', { workforcePolicy: {} }],
    ] as const) assert.equal(requiresFacilityContract({ table, data }), true);
    assert.equal(requiresFacilityContract({ table: 'staff', data: { role: 'doctor' } }), false);
    assert.equal(requiresFacilityContract({ table: 'unit', data: { name: 'Rename existing unit' } }), false);
  });
  it('protects server-only authority, external provenance and cutover from uploaded claims', () => {
    for (const table of ['authority_snapshot', 'clinical_authority_bootstrap', 'external_clinical_reviewer', 'appointment_reservation']) assert.ok(facilityMutationIssues({ ...mutation, table }).length);
    assert.ok(facilityMutationIssues({ ...mutation, table: 'capability_decision', data: { schemaVersion: 4, createdBy: 'system' } }).length);
    assert.ok(facilityMutationIssues({ ...mutation, table: 'credential', data: { schemaVersion: 4, externalReviewerId: 'external:one' } }).length);
    assert.ok(facilityMutationIssues({ ...mutation, table: 'facility', data: { workforcePolicy: {} } }).length);
  });
  it('requires exact configuration CAS and immutable predecessor contracts without overwriting replayed history', () => {
    assert.deepEqual(facilityMutationIssues(mutation), []);
    assert.ok(facilityMutationIssues({ ...mutation, data: { ...location, revision: 2 } }).length);
    const update: FacilityMutation = { ...mutation, expectedRevision: 1, data: { ...location, revision: 2 } };
    assert.deepEqual(facilityMutationIssues(update, location), []);
    assert.ok(facilityMutationIssues({ ...update, expectedRevision: 2 }, location).length);
    assert.ok(facilityMutationIssues(update, { ...location, id: 'location:other' }).length);
    assert.deepEqual(configurationRevisionIssues(1, undefined), []);
    const create = { ...mutation, table: 'staff_assignment', id: assignment.id, data: assignment, expectedPreviousId: null };
    assert.deepEqual(facilityMutationIssues(create), []);
    assert.ok(facilityMutationIssues({ ...create, expectedPreviousId: undefined }).length);
    assert.ok(facilityMutationIssues({ ...create, op: 'patch' }).length);
    assert.ok(facilityMutationIssues({ ...create, op: 'delete' }).length);
    const unitChange = { ...mutation, table: 'unit', id: 'unit:legacy', expectedRevision: 1, data: { schemaVersion: 4, parentId: 'unit:parent', revision: 2 } };
    assert.deepEqual(facilityMutationIssues(unitChange, { id: unitChange.id }), []);
    assert.ok(facilityMutationIssues({ ...unitChange, expectedRevision: undefined }, { id: unitChange.id }).length);
    assert.ok(facilityMutationIssues({ ...unitChange, data: { ...unitChange.data, schemaVersion: 3 } }, { id: unitChange.id }).length);
  });
  it('acknowledges missing-parent work only with a durable linked reconciliation record, so the upload queue can advance', () => {
    const dependency = { clientId: 2, table: 'service_offering', id: 'offering:one', category: 'dependency', reason: 'Parent unit was not accepted', dependencies: [{ table: 'unit', id: 'unit:one' }] };
    const response = { applied: 0, duplicates: 1, rejected: [dependency], serverTime: envelope.createdOn, facilityContractVersion: 1 };
    assert.equal(UploadResponse.safeParse(response).success, true);
    assert.equal(UploadResponse.safeParse({ ...response, facilityContractVersion: undefined }).success, false);
    assert.equal(UploadResponse.safeParse({ ...response, rejected: [dependency, dependency] }).success, false);
    const record = { ...envelope, id: 'rejection:dependency', type: 'sync_rejection', entityType: 'service_offering', entityId: dependency.id, operation: 'put',
      category: dependency.category, reason: dependency.reason, dependencies: dependency.dependencies, refusedRecord: { id: dependency.id, unitId: 'unit:one' } };
    assert.equal(SyncRejection.safeParse(record).success, true);
    assert.equal(SyncRejection.safeParse({ ...record, refusedRecord: undefined }).success, false);
    assert.equal(SyncRejection.safeParse({ ...record, dependencies: undefined }).success, false);
  });
  it('does not activate enforcement merely because a facility or supported client exists', () => {
    assert.equal(workforceEnforcementActive(undefined, NOW), false);
    const policy = FacilityWorkforcePolicy.parse({ contractVersion: 1, schemaVersion: 4, policyVersion: 10,
      revision: 1, mode: 'enforced', effectiveOn: '2026-10-30T10:00:00Z', governanceReference: 'governance:cutover' });
    assert.equal(workforceEnforcementActive(policy, NOW), false);
    assert.equal(workforceEnforcementActive(policy, Date.parse(policy.effectiveOn!)), true);
    assert.equal(FacilityWorkforcePolicy.safeParse({ ...policy, effectiveOn: undefined }).success, false);
    assert.equal(workforceEnforcementActive({ ...policy, mode: 'preparation' }, NOW), false);
  });
  it('does not let refused evidence leak through the ordinary reconciliation stream', () => {
    const record = { ...envelope, type: 'sync_rejection', id: 'rejection:evidence', entityType: 'credential', entityId: 'credential:one', operation: 'put', category: 'validation', reason: 'Review evidence', refusedRecord: { evidenceReference: 'private:evidence' } };
    assert.equal(SyncRejection.safeParse(record).success, false);
    assert.equal(SyncRejection.safeParse({ ...record, visibility: 'restricted', visibleToStaffIds: [] }).success, false);
    assert.equal(SyncRejection.safeParse({ ...record, visibility: 'restricted', visibleToStaffIds: ['staff:reviewer'] }).success, true);
  });
});
