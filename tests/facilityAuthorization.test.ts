import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  AuthoritySnapshot, CapabilityDecision, ClinicalAuthorityBootstrap, Credential, EncounterEntry, ExternalClinicalReviewer,
  ReviewerDelegation, assessDelayedClinicalTime, assignmentEligibilityIssues, authorityProofIssues, authoritySignaturePayload,
  clinicalActivityIssues, clinicalEventActions, credentialSupportsInterval, encounterClinicalActions, externalReviewerIssues,
  projectClinicalAuthority, reviewerDecisionIssues, staffPermissions, withReviewerAuthority, mayApproveWorkforcePin, staffGovernanceIssues,
  sessionClinicalCoverageIssues,
} from '../src/index.ts';
import { NOW, assignment, contextFor, credential, decision, envelope, offering, patientId, proofFor, reviewer, session, worker } from './facilityFixtures.ts';

const reviewProof = () => {
  const proof = proofFor(reviewer);
  proof.snapshot.reviewScopes = [{ decisionId: 'bootstrap:one:v1', scope: decision.scope, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-30T23:00:00Z' }];
  proof.snapshot.sourceDecisionIds.push('bootstrap:one:v1');
  return proof;
};

describe('protected clinical authority', () => {
  it('never derives clinical or review authority from administrator, role grants or an unsigned roster', () => {
    assert.equal(staffPermissions(reviewer).includes('clinical_capability:review'), false);
    const context = contextFor(reviewer);
    assert.ok(clinicalActivityIssues(reviewer, context, undefined, { action: 'diagnose', offeringId: offering.id }, NOW).length);
    assert.ok(reviewerDecisionIssues(reviewer, { ...context, permissions: [...context.permissions, 'clinical_capability:review'] }, proofFor(reviewer), decision, NOW).length);
    assert.equal(withReviewerAuthority(context, reviewer, proofFor(reviewer), NOW).permissions.includes('clinical_capability:review'), false);
    assert.deepEqual(reviewerDecisionIssues(reviewer, context, reviewProof(), decision, NOW), []);
  });
  it('requires exact subject/facility, a supported policy, trusted proof and a bounded trusted clock', () => {
    const context = contextFor(worker), proof = proofFor();
    assert.deepEqual(clinicalActivityIssues(worker, context, proof, { action: 'diagnose', offeringId: offering.id }, NOW), []);
    for (const modified of [
      { ...proof, signatureVerified: false }, { ...proof, currentRevision: 2 },
      { ...proof, snapshot: { ...proof.snapshot, staffId: reviewer.staffId } },
      { ...proof, snapshot: { ...proof.snapshot, facilityId: 'OTHER' } },
      { ...proof, snapshot: { ...proof.snapshot, policyVersion: 14 } },
    ]) assert.ok(authorityProofIssues(context, modified, NOW).length);
    assert.deepEqual(authorityProofIssues({ ...context, policyVersion: 11 }, proof, NOW), []);
    assert.ok(authorityProofIssues(context, proof, Date.parse(proof.snapshot.expiresOn)).length);
    assert.ok(authorityProofIssues(context, proof, Date.parse(proof.snapshot.issuedOn) - 1).length);
    assert.ok(authorityProofIssues(context, proof, NaN).length);
    assert.ok(clinicalActivityIssues({ ...worker, permission: 'read_only' }, context, proof, { action: 'diagnose', offeringId: offering.id }, NOW).length);
    assert.ok(clinicalActivityIssues(worker, context, proof, { action: 'diagnose', offeringId: 'offering:other' }, NOW).length);
    assert.ok(clinicalActivityIssues(worker, { ...context, lastServerContactOn: '2026-10-01T00:00:00Z' }, proof, { action: 'diagnose', offeringId: offering.id }, NOW).length);
    assert.equal(AuthoritySnapshot.safeParse({ ...proof.snapshot, expiresOn: '2026-11-30T00:00:00Z' }).success, false);
  });
  it('requires independent qualified supervision/checking and rejects self-supervision', () => {
    const context = contextFor(worker), proof = proofFor();
    proof.snapshot.grants[0].supervisorId = 'staff:supervisor'; proof.snapshot.grants[0].independentCheck = true;
    const request = { action: 'diagnose' as const, offeringId: offering.id };
    assert.ok(clinicalActivityIssues(worker, context, proof, request, NOW).length);
    assert.ok(clinicalActivityIssues(worker, context, proof, { ...request, availableQualifiedActorIds: [worker.staffId] }, NOW).length);
    assert.deepEqual(clinicalActivityIssues(worker, context, proof, { ...request, availableQualifiedActorIds: ['staff:supervisor'] }, NOW), []);
    assert.equal(AuthoritySnapshot.safeParse({ ...proof.snapshot, grants: [{ ...proof.snapshot.grants[0], supervisorId: worker.staffId }] }).success, false);
    assert.ok(assignmentEligibilityIssues(assignment, worker, context, proof, session, offering.requiredActions, NOW).length);
    assert.deepEqual(assignmentEligibilityIssues({ ...assignment, supervisorId: 'staff:supervisor' }, worker, context, proof, session, offering.requiredActions, NOW), []);
  });
  it('does not approve oneself or widen a downstream reviewer scope or term', () => {
    const proof = reviewProof(), context = contextFor(reviewer);
    assert.equal(CapabilityDecision.safeParse({ ...decision, createdBy: worker.staffId }).success, false);
    assert.ok(reviewerDecisionIssues(reviewer, context, proof, { ...decision, staffId: reviewer.staffId }, NOW).length);
    assert.ok(reviewerDecisionIssues(reviewer, context, proof, { ...decision, scope: { kind: 'facility', actions: ['diagnose'] } }, NOW).length);
    const delegation = ReviewerDelegation.parse({ ...envelope, type: 'reviewer_delegation', id: 'delegation:one:v1', delegationId: 'delegation:one', version: 1,
      staffId: worker.staffId, scopes: [decision.scope], startsAt: '2026-10-29T09:00:00Z', endsAt: '2026-11-01T00:00:00Z', decision: 'approve', reason: 'Approved independent reviewer duties' });
    assert.deepEqual(reviewerDecisionIssues(reviewer, context, proof, delegation, NOW), []);
    assert.ok(reviewerDecisionIssues(reviewer, context, proof, { ...delegation, endsAt: undefined }, NOW).length);
    assert.ok(reviewerDecisionIssues(reviewer, { ...context, lastServerContactOn: '2026-10-27T08:00:00Z' }, proof, delegation, NOW).length);
    assert.ok(reviewerDecisionIssues({ ...reviewer, permission: 'read_only' }, context, proof, delegation, NOW).length);
  });
  it('records a legitimate external review without a fictitious local practitioner account', () => {
    const external = ExternalClinicalReviewer.parse({ ...envelope, type: 'external_clinical_reviewer', id: 'external:one', createdBy: 'system',
      externalSubjectReference: 'governance:external-identity', displayName: 'Synthetic external verifier', governanceReference: 'governance:one', authorizedBy: 'operator:approved',
      scopes: [decision.scope], startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z', active: true, revision: 1 });
    const externalDecision = CapabilityDecision.parse({ ...decision, createdBy: 'system', externalReviewerId: external.id });
    assert.deepEqual(externalReviewerIssues(external, externalDecision, true, NOW), []);
    assert.ok(externalReviewerIssues(external, externalDecision, false, NOW).length);
    assert.ok(externalReviewerIssues({ ...external, linkedStaffId: worker.staffId }, externalDecision, true, NOW).length);
    assert.ok(externalReviewerIssues({ ...external, active: false }, externalDecision, true, NOW).length);
    assert.equal(CapabilityDecision.safeParse({ ...externalDecision, createdBy: reviewer.staffId }).success, false);
    assert.equal(Credential.safeParse({ ...credential, checkedBy: worker.staffId, createdBy: worker.staffId }).success, false);
  });
  it('protects prescribing, administration, results and amendments through source content', () => {
    const original = EncounterEntry.parse({ ...envelope, type: 'encounter_entry', id: 'entry:diagnosis', patientId, encounterId: 'encounter:one', step: 'diagnosis', actorRole: 'doctor', values: { diagnosis: 'Synthetic diagnosis', prescription: [] } });
    assert.deepEqual(encounterClinicalActions(original), ['diagnose']);
    const amendment = EncounterEntry.parse({ ...original, id: 'entry:amendment', step: 'amendment', amends: original.id,
      values: { note: 'Synthetic correction', correctedValues: { diagnosis: 'Synthetic diagnosis', prescription: [{ drug: 'Synthetic medicine', dose: 'Synthetic dose' }] } } });
    assert.deepEqual(encounterClinicalActions(amendment, original), ['diagnose', 'prescribe']);
    assert.throws(() => encounterClinicalActions(amendment), /original entry/);
    assert.throws(() => encounterClinicalActions(amendment, { ...original, patientId: 'TEST-PHC-000048-K3' }));
    const prescribed = { ...original, values: amendment.values.correctedValues as Record<string, unknown> };
    assert.deepEqual(encounterClinicalActions({ ...amendment, values: { note: 'Remove medicine', correctedValues: original.values } }, prescribed), ['diagnose', 'prescribe']);
    assert.deepEqual(encounterClinicalActions({ ...original, step: 'lab_results' }), ['record_result']);
    assert.deepEqual(encounterClinicalActions({ ...original, step: 'injection' }), ['administer']);
    assert.deepEqual(encounterClinicalActions({ ...original, step: 'dispense' }), ['dispense']);
    assert.deepEqual(clinicalEventActions({ kind: 'medication' }), ['prescribe']);
  });
  it('uses inclusive credential dates in the credential zone, including DST days', () => {
    const lagos = { ...credential, validThrough: '2026-10-29' };
    assert.equal(credentialSupportsInterval(lagos, { startsAt: '2026-10-29T10:00:00Z', endsAt: '2026-10-29T23:00:00Z' }), true);
    assert.equal(credentialSupportsInterval(lagos, { startsAt: '2026-10-29T10:00:00Z', endsAt: '2026-10-29T23:00:00.001Z' }), false);
    assert.equal(credentialSupportsInterval(lagos, { startsAt: '2026-10-29T10:00:00Z' }), false);
    const dst = { ...credential, timeZone: 'America/New_York', validThrough: '2026-11-01' };
    assert.equal(credentialSupportsInterval(dst, { startsAt: '2026-11-01T04:00:00Z', endsAt: '2026-11-02T05:00:00Z' }), true);
    assert.equal(credentialSupportsInterval(dst, { startsAt: '2026-11-01T04:00:00Z', endsAt: '2026-11-02T05:00:00.001Z' }), false);
  });
  it('signs normalized scope and exact authority without depending on row bookkeeping or object order', () => {
    const proof = proofFor(), snapshot = proof.snapshot;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const signature = sign(null, Buffer.from(authoritySignaturePayload(snapshot)), privateKey);
    const reserialized = { ...snapshot, updatedOn: '2026-10-30T00:00:00Z', issuedOn: '2026-10-29T09:00:00+01:00', grants: snapshot.grants.map((g) => ({ ...g, scope: { kind: 'offerings' as const, offeringIds: [offering.id], actions: [...g.scope.actions].reverse() } })) };
    assert.equal(verify(null, Buffer.from(authoritySignaturePayload(reserialized)), publicKey, signature), true);
    for (const tamper of [{ ...snapshot, facilityId: 'OTHER' }, { ...snapshot, revision: 2 }, { ...snapshot, grants: [] }, { ...snapshot, keyId: 'key:other' }]) assert.equal(verify(null, Buffer.from(authoritySignaturePayload(tamper)), publicKey, signature), false);
  });
  it('prevents an unapproved administrator using a PIN reset to take over an approved clinical identity', () => {
    const context = contextFor(reviewer), target = proofFor().snapshot;
    assert.equal(mayApproveWorkforcePin(reviewer, context, proofFor(reviewer), worker, target, NOW), false);
    assert.equal(mayApproveWorkforcePin(reviewer, context, reviewProof(), worker, target, NOW), true);
    assert.equal(mayApproveWorkforcePin(reviewer, { ...context, lastServerContactOn: '2026-10-27T08:00:00Z' }, reviewProof(), worker, target, NOW), false);
    assert.equal(mayApproveWorkforcePin(reviewer, context, reviewProof(), worker, { ...target, expiresOn: '2026-10-28T08:00:00Z' }, NOW), false);
    assert.equal(mayApproveWorkforcePin({ ...reviewer, permission: 'read_only' }, context, reviewProof(), worker, target, NOW), false);
    assert.ok(staffGovernanceIssues({ ...reviewer, active: false }, reviewer, [reviewer, worker]).length);
    const secondAdmin = { ...reviewer, id: 'staff:admin-two', staffId: 'staff:admin-two' };
    assert.deepEqual(staffGovernanceIssues({ ...reviewer, active: false }, reviewer, [reviewer, secondAdmin]), []);
    assert.ok(staffGovernanceIssues({ ...reviewer, active: false }, reviewer, [reviewer, { ...secondAdmin, facilityId: 'OTHER' }]).length);
  });
  it('allows a mixed hospital team to cover complementary duties and retains nonclinical support roles', () => {
    const clinical = { staff: worker, assignment, context: contextFor(worker), proof: proofFor() };
    const support = { staff: reviewer, assignment: { ...assignment, id: 'assignment:support:v1', assignmentId: 'assignment:support', staffId: reviewer.staffId, duty: 'support' as const, requiredActions: [] }, context: contextFor(reviewer) };
    const coverage = { ...session, participants: [...session.participants, { staffId: reviewer.staffId, assignmentId: support.assignment.assignmentId, commitment: 'shared' as const }] };
    assert.deepEqual(sessionClinicalCoverageIssues(offering, coverage, [clinical, support], NOW), []);
    assert.ok(sessionClinicalCoverageIssues({ ...offering, requiredActions: ['assess', 'prescribe'] }, coverage, [clinical, support], NOW).some((s) => s.includes('prescribe')));
    const prescribing = { ...support, assignment: { ...support.assignment, duty: 'member' as const, requiredActions: ['prescribe' as const] }, proof: proofFor(reviewer) };
    assert.deepEqual(sessionClinicalCoverageIssues({ ...offering, requiredActions: ['assess', 'prescribe'] }, coverage, [clinical, prescribing], NOW), []);
  });
});

describe('accepted minimal authority projection', () => {
  const sources = { decisions: [decision], credentials: [credential], delegations: [], bootstraps: [] };
  it('projects accepted evidence, preserves history and removes withdrawn/forked/disabled authority', () => {
    assert.equal(projectClinicalAuthority(worker, sources, NOW).grants.length, 1);
    assert.equal(projectClinicalAuthority({ ...worker, active: false }, sources, NOW).grants.length, 0);
    assert.equal(projectClinicalAuthority({ ...worker, permission: 'read_only' }, sources, NOW).grants.length, 0);
    const revoked = CapabilityDecision.parse({ ...decision, id: 'capability:one:v2', previousId: decision.id, version: 2, startsAt: '2026-10-29T09:00:00Z', decision: 'revoke', credentialRevisionIds: [] });
    assert.equal(projectClinicalAuthority(worker, { ...sources, decisions: [decision, revoked] }, NOW).grants.length, 0);
    assert.equal(projectClinicalAuthority(worker, { ...sources, decisions: [decision, { ...revoked, decision: 'approve' }, { ...revoked, id: 'capability:fork' }] }, NOW).grants.length, 0);
    assert.equal(projectClinicalAuthority(worker, { ...sources, credentials: [{ ...credential, verification: 'withdrawn' }] }, NOW).grants.length, 0);
    assert.equal(decision.decision, 'approve');
  });
  it('expires offline proof at a known future restriction instead of prematurely revoking current work', () => {
    const future = CapabilityDecision.parse({ ...decision, id: 'capability:one:v2', previousId: decision.id, version: 2, decision: 'revoke', startsAt: '2026-10-30T10:00:00Z', credentialRevisionIds: [] });
    const input = { ...sources, decisions: [decision, future] };
    assert.equal(projectClinicalAuthority(worker, input, NOW).grants.length, 1);
    assert.equal(projectClinicalAuthority(worker, input, NOW).expiresOn, future.startsAt.replace('Z', '.000Z'));
    assert.equal(projectClinicalAuthority(worker, input, NOW).grants[0].endsAt, future.startsAt.replace('Z', '.000Z'));
    assert.equal(projectClinicalAuthority(worker, input, Date.parse(future.startsAt)).grants.length, 0);
  });
  it('supports audited first-reviewer bootstrap and its explicit revocation', () => {
    const bootstrap = ClinicalAuthorityBootstrap.parse({ ...envelope, type: 'clinical_authority_bootstrap', createdBy: 'system', id: 'bootstrap:one:v1', bootstrapId: 'bootstrap:one', version: 1,
      decision: 'approve', staffId: reviewer.staffId, scopes: [decision.scope], startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-30T23:00:00Z', governanceReference: 'governance:one', authorizedBy: 'operator:approved', reason: 'Audited initial verifier' });
    const input = { ...sources, decisions: [], bootstraps: [bootstrap] };
    assert.equal(projectClinicalAuthority(reviewer, input, NOW).reviewScopes.length, 1);
    const revoke = ClinicalAuthorityBootstrap.parse({ ...bootstrap, id: 'bootstrap:one:v2', previousId: bootstrap.id, version: 2, decision: 'revoke', startsAt: '2026-10-29T09:00:00Z', reason: 'End delegation' });
    assert.equal(projectClinicalAuthority(reviewer, { ...input, bootstraps: [bootstrap, revoke] }, NOW).reviewScopes.length, 0);
  });
});

describe('delayed care and time evidence', () => {
  const input = { performedOn: '2026-10-29T09:00:00Z', receivedOn: '2026-10-29T10:00:00Z', lastTrustedServerOn: '2026-10-28T10:00:00Z', maximumClockSkewMs: 60_000, maximumOfflineMs: 7 * 86_400_000, authorityExpiresOn: '2026-10-30T10:00:00Z' };
  it('distinguishes current authority, expired/revoked delayed evidence and impossible time claims', () => {
    assert.equal(assessDelayedClinicalTime(input), 'current');
    assert.equal(assessDelayedClinicalTime({ ...input, receivedOn: '2026-10-31T10:00:00Z' }), 'historical_review');
    assert.equal(assessDelayedClinicalTime({ ...input, revokedOn: '2026-10-29T09:30:00Z' }), 'historical_review');
    assert.equal(assessDelayedClinicalTime({ ...input, performedOn: '2026-11-02T10:00:00Z' }), 'invalid_time');
    assert.equal(assessDelayedClinicalTime({ ...input, maximumClockSkewMs: NaN }), 'invalid_time');
  });
});
