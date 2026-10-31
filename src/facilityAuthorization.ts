import { ENCOUNTER_STEP_VALUES, type Staff, type EncounterEntry } from './documents.ts';
import type { ClinicalEvent } from './clinical.ts';
import type { AuthoritySnapshot, CapabilityDecision, Credential, ExternalClinicalReviewer, ReviewerDelegation } from './facility.ts';
import { intervalContains, scopeAllows, scopeContains, FACILITY_MIN_POLICY_VERSION, type ClinicalAction } from './facilityTypes.ts';
import { CLINICAL_ACTION_PERMISSIONS, POLICY_VERSION, decide, isWithinOfflineWindow, mayApprovePin, rolesFor, type AuthorizationContext } from './permissions.ts';
import type { Permission } from './capabilities.ts';
import type { ServiceOffering, ServiceSession, StaffAssignment } from './facility.ts';

export type AuthorityProof = {
  snapshot: AuthoritySnapshot;
  /** Set only after crypto verification of these exact bytes with a trusted server key. Never request JSON. */
  signatureVerified: boolean;
  /** Highest accepted revision known locally; server always re-derives current authority. */
  currentRevision: number;
};
// Policy 11 adds admission operations; it does not change signed clinical scope.
const supportedClinicalPolicy = (version: number) => version >= FACILITY_MIN_POLICY_VERSION && version <= POLICY_VERSION;
export const authorityProofIssues = (context: AuthorizationContext, proof: AuthorityProof | undefined, now: number): string[] => {
  if (!proof || !proof.signatureVerified) return ['Trusted server-signed clinical authority is required'];
  const snapshot = proof.snapshot;
  if (!supportedClinicalPolicy(context.policyVersion) || !supportedClinicalPolicy(snapshot.policyVersion)) return ['Clinical authority policy is incompatible'];
  if (snapshot.staffId !== context.userId || snapshot.facilityId !== context.facilityId || snapshot.revision !== proof.currentRevision) return ['Clinical authority does not match the current worker, facility or revision'];
  if (!Number.isFinite(now) || now < Date.parse(snapshot.issuedOn) || now >= Date.parse(snapshot.expiresOn)) return ['Clinical authority is expired or the trusted time is invalid'];
  return [];
};

/** Only accepted proof enriches review access; role/additional grants cannot do so. */
export const withReviewerAuthority = (context: AuthorizationContext, staff: Staff, proof: AuthorityProof | undefined, now: number): AuthorizationContext => {
  const permissions: Permission[] = context.permissions.filter((p) => p !== 'clinical_capability:review');
  if (staff.active && staff.permission === 'read_write' && staff.staffId === context.userId && staff.facilityId === context.facilityId
    && !authorityProofIssues(context, proof, now).length && proof!.snapshot.reviewScopes.some((g) => intervalContains(g, now))) permissions.push('clinical_capability:review');
  return { ...context, permissions };
};
export type ClinicalActivityRequest = {
  action: ClinicalAction; offeringId: string;
  /** Trusted caller establishes presence, identity AND qualification for this action. */
  availableQualifiedActorIds?: readonly string[];
};
/** Software access AND accepted clinical authority; assignment/ownership conflicts are separate. */
export const clinicalActivityIssues = (staff: Staff, context: AuthorizationContext, proof: AuthorityProof | undefined, request: ClinicalActivityRequest, now: number): string[] => {
  if (!staff.active || staff.permission !== 'read_write' || staff.staffId !== context.userId || staff.facilityId !== context.facilityId) return ['An active writable facility member must perform the activity'];
  if (decide(context, CLINICAL_ACTION_PERMISSIONS[request.action], now)) return ['Software access is absent or stale for this clinical activity'];
  const issues = authorityProofIssues(context, proof, now); if (issues.length) return issues;
  const actors = (request.availableQualifiedActorIds ?? []).filter((id) => id !== staff.staffId);
  const grants = proof!.snapshot.grants.filter((g) => scopeAllows(g.scope, request.action, request.offeringId) && intervalContains(g, now));
  if (!grants.length) return ['No effective clinical grant covers this action and service'];
  if (!grants.some((g) => (!g.supervisorId || actors.includes(g.supervisorId)) && (!g.independentCheck || actors.length > 0))) return ['Required independent supervisor/checker is unavailable'];
  return [];
};

/** Reviewers cannot widen delegated scopes or extend delegation beyond their own term. */
export const reviewerDecisionIssues = (staff: Staff, context: AuthorizationContext, proof: AuthorityProof | undefined, decision: CapabilityDecision | ReviewerDelegation, now: number): string[] => {
  if (decision.facilityId !== context.facilityId || decision.createdBy !== context.userId || decision.staffId === context.userId) return ['Review must be independently authored in the same facility'];
  if (decide(withReviewerAuthority(context, staff, proof, now), 'clinical_capability:review', now)) return ['Accepted, fresh clinical reviewer authority is required'];
  const issues = authorityProofIssues(context, proof, now); if (issues.length) return issues;
  const scopes = decision.type === 'capability_decision' ? [decision.scope] : decision.scopes;
  return scopes.every((scope) => proof!.snapshot.reviewScopes.some((authority) => intervalContains(authority, now) && scopeContains(authority.scope, scope)
    && (decision.type !== 'reviewer_delegation' || (Date.parse(decision.startsAt) >= Date.parse(authority.startsAt)
      && (!authority.endsAt || Boolean(decision.endsAt) && Date.parse(decision.endsAt!) <= Date.parse(authority.endsAt)))))) ? [] : ['Reviewer cannot approve/delegate outside their accepted scope or term'];
};
export const externalReviewerIssues = (reviewer: ExternalClinicalReviewer, decision: CapabilityDecision | Credential, trustedSetupOperation: boolean, now: number): string[] => {
  if (!trustedSetupOperation || decision.createdBy !== 'system' || decision.externalReviewerId !== reviewer.id) return ['External review requires the authorized audited server operation'];
  if (!reviewer.active || reviewer.facilityId !== decision.facilityId || reviewer.linkedStaffId === decision.staffId || !intervalContains(reviewer, now)) return ['External reviewer must be independent, active and authorized in this facility'];
  if (decision.type === 'capability_decision' && !reviewer.scopes.some((s) => scopeContains(s, decision.scope))) return ['External reviewer scope does not cover this decision'];
  return [];
};

/** Authoritative accepted target proof is required after cutover, including an explicitly empty projection. */
export const mayApproveWorkforcePin = (approver: Staff, context: AuthorizationContext, proof: AuthorityProof | undefined,
  target: Staff, targetAuthority: AuthoritySnapshot, now: number): boolean => {
  if (!approver.active || !target.active || approver.staffId !== context.userId || approver.facilityId !== context.facilityId || target.facilityId !== context.facilityId
    || !isWithinOfflineWindow('staff:manage', context.lastServerContactOn, now) || !mayApprovePin(approver, target)
    || targetAuthority.staffId !== target.staffId || targetAuthority.facilityId !== target.facilityId || !supportedClinicalPolicy(targetAuthority.policyVersion)
    || now < Date.parse(targetAuthority.issuedOn) || now >= Date.parse(targetAuthority.expiresOn)) return false;
  const protectedScopes = [...targetAuthority.reviewScopes, ...targetAuthority.grants].filter((g) => intervalContains(g, now));
  if (!protectedScopes.length) return true;
  if (authorityProofIssues(context, proof, now).length || decide(withReviewerAuthority(context, approver, proof, now), 'clinical_capability:review', now)) return false;
  return protectedScopes.every((targetGrant) => proof!.snapshot.reviewScopes.some((g) => intervalContains(g, now) && scopeContains(g.scope, targetGrant.scope)));
};
/** Configuration cannot strand a facility without a writable administrator. Unsafe clinical grants may still be revoked. */
export const staffGovernanceIssues = (next: Staff, current: Staff, facilityStaff: readonly Staff[]): string[] => {
  if (next.id !== current.id || next.staffId !== current.staffId || next.facilityId !== current.facilityId) return ['Staff access changes must preserve facility identity'];
  const manager = (s: Staff) => s.active && s.permission === 'read_write' && rolesFor(s).includes('facility_admin');
  return manager(current) && !manager(next) && !facilityStaff.some((s) => s.staffId !== current.staffId && s.facilityId === current.facilityId && manager(s))
    ? ['Add another writable facility administrator before removing the last one'] : [];
};
const localDate = (instant: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const part = (key: string) => parts.find((p) => p.type === key)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
/** Inclusive local expiry date; expiring evidence cannot support an unbounded grant. */
export const credentialSupportsInterval = (credential: Credential, interval: { startsAt: string; endsAt?: string }): boolean => {
  if (credential.verification !== 'verified') return false;
  const first = localDate(Date.parse(interval.startsAt), credential.timeZone);
  if (credential.issuedOn && first < credential.issuedOn) return false;
  if (!credential.validThrough) return true;
  return Boolean(interval.endsAt) && first <= credential.validThrough && localDate(Date.parse(interval.endsAt!) - 1, credential.timeZone) <= credential.validThrough;
};

/** Checks planned clinical coverage for a finite occurrence. It never creates authority from an assignment. */
export const assignmentEligibilityIssues = (assignment: StaffAssignment, staff: Staff, context: AuthorizationContext, proof: AuthorityProof | undefined,
  interval: { startsAt: string; endsAt: string }, requiredActions: readonly ClinicalAction[], now: number): string[] => {
  if (!staff.active || staff.permission !== 'read_write' || staff.staffId !== assignment.staffId || staff.staffId !== context.userId
    || assignment.facilityId !== context.facilityId || staff.facilityId !== context.facilityId || assignment.status !== 'active'
    || !intervalContains(assignment, Date.parse(interval.startsAt)) || assignment.endsAt && Date.parse(interval.endsAt) > Date.parse(assignment.endsAt)) return ['Worker needs an active assignment covering the complete occurrence'];
  const actions = [...new Set([...assignment.requiredActions, ...requiredActions])];
  if (!actions.length) return []; // Administrative/support assignments need no fabricated clinical credential.
  const issues = authorityProofIssues(context, proof, now); if (issues.length) return issues;
  return actions.flatMap((action) => {
    if (decide(context, CLINICAL_ACTION_PERMISSIONS[action], now)) return [`Software access is missing/stale for ${action}`];
    return proof!.snapshot.grants.some((g) => scopeAllows(g.scope, action, assignment.offeringId) && intervalContains(g, Date.parse(interval.startsAt))
      && (!g.endsAt || Date.parse(interval.endsAt) <= Date.parse(g.endsAt)) && (!g.supervisorId || assignment.supervisorId === g.supervisorId)) ? [] : [`Approved ${action} scope/supervision does not cover the complete occurrence`];
  });
};

/** A hospital team can cover different activities collectively; support staff need no invented clinical grant. */
export const sessionClinicalCoverageIssues = (offering: ServiceOffering, session: ServiceSession, people: readonly {
  staff: Staff; assignment: StaffAssignment; context: AuthorizationContext; proof?: AuthorityProof;
}[], now: number): string[] => {
  if (offering.facilityId !== session.facilityId || offering.id !== session.offeringId) return ['Coverage must belong to this service and facility'];
  const issues: string[] = [];
  const members = session.participants.flatMap((p) => {
    const matches = people.filter((v) => v.staff.staffId === p.staffId && v.assignment.assignmentId === p.assignmentId
      && v.assignment.offeringId === offering.id && v.assignment.facilityId === offering.facilityId);
    if (matches.length !== 1) { issues.push('Each participant needs one unambiguous effective assignment context'); return []; }
    const member = matches[0];
    issues.push(...assignmentEligibilityIssues(member.assignment, member.staff, member.context, member.proof, session, [], now));
    return [member];
  });
  for (const action of offering.requiredActions) if (!members.some((m) => (m.assignment.requiredActions.includes(action)
    || m.assignment.duty !== 'support' && m.assignment.requiredActions.length === 0)
    && assignmentEligibilityIssues(m.assignment, m.staff, m.context, m.proof, session, [action], now).length === 0)) issues.push(`Service has no qualified assigned coverage for ${action}`);
  return issues;
};

/** Applies to existing steps and amendments. Missing/invalid original content fails closed. */
export const encounterClinicalActions = (entry: EncounterEntry, original?: EncounterEntry): ClinicalAction[] => {
  if (entry.step === 'amendment') {
    if (!original || original.step === 'amendment' || entry.amends !== original.id || entry.facilityId !== original.facilityId
      || entry.patientId !== original.patientId || entry.encounterId !== original.encounterId) throw new Error('Amendment needs its original entry in the same encounter');
    const corrected = entry.values.correctedValues;
    const before = encounterClinicalActions(original);
    if (!corrected) return before;
    const values = ENCOUNTER_STEP_VALUES[original.step].parse(corrected) as Record<string, unknown>;
    return [...new Set([...before, ...encounterClinicalActions({ ...original, values })])];
  }
  switch (entry.step) {
    case 'diagnosis': return (Array.isArray(entry.values.prescription) && entry.values.prescription.length > 0) || entry.values.giveInjection === true ? ['diagnose', 'prescribe'] : ['diagnose'];
    case 'prescription': return entry.values.decision === 'prescribed' ? ['prescribe'] : ['assess'];
    case 'injection_order': return entry.values.required ? ['prescribe'] : ['assess'];
    case 'lab_results': return ['record_result'];
    case 'injection': return ['administer'];
    case 'dispense': return ['dispense'];
    default: return ['assess'];
  }
};
export const clinicalEventActions = (event: Pick<ClinicalEvent, 'kind'>): ClinicalAction[] =>
  event.kind === 'problem' ? ['diagnose'] : event.kind === 'medication' ? ['prescribe'] : ['assess'];

export type DelayedClinicalAssessment = 'current' | 'historical_review' | 'invalid_time';
/** Retain evidence for review instead of trusting backdating or discarding performed care. */
export const assessDelayedClinicalTime = (input: {
  performedOn: string; receivedOn: string; lastTrustedServerOn: string;
  maximumClockSkewMs: number; maximumOfflineMs: number; authorityExpiresOn: string; revokedOn?: string;
}): DelayedClinicalAssessment => {
  const [performed, received, trusted, expires] = [input.performedOn, input.receivedOn, input.lastTrustedServerOn, input.authorityExpiresOn].map(Date.parse);
  const revoked = input.revokedOn ? Date.parse(input.revokedOn) : Infinity;
  if (![performed, received, trusted, expires, input.maximumClockSkewMs, input.maximumOfflineMs].every(Number.isFinite) || Number.isNaN(revoked) || input.maximumClockSkewMs < 0 || input.maximumOfflineMs < 0
    || performed > received + input.maximumClockSkewMs || performed < trusted - input.maximumClockSkewMs || received < trusted - input.maximumClockSkewMs) return 'invalid_time';
  return received - trusted > input.maximumOfflineMs || performed >= expires || received >= expires || received >= revoked || performed >= revoked ? 'historical_review' : 'current';
};
