import { z } from 'zod';
import { baseEnvelope, patientId, SCHEMA_VERSION } from './common.ts';
import {
  CodedConcept, ClinicalAction, ClinicalActions, ClinicalScope, FacilityDate, FacilityInstant,
  FacilityTimeZone, Interval, LocationKind, ServiceCategory, distinctRefs, facilityIdRef as ref,
  facilityText as text, FACILITY_MIN_POLICY_VERSION,
} from './facilityTypes.ts';

const version = z.number().int().positive();
const revisionFields = { version, previousId: ref.optional() };
const intervalFields = { startsAt: FacilityInstant, endsAt: FacilityInstant.optional() };
const record = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...baseEnvelope.shape, schemaVersion: z.number().int().min(4).max(SCHEMA_VERSION).default(SCHEMA_VERSION), ...shape });
const checkInterval = (v: { startsAt: string; endsAt?: string }, ctx: z.RefinementCtx) => {
  if (v.endsAt && Date.parse(v.endsAt) <= Date.parse(v.startsAt)) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'End must be after start' });
};
const checkRevision = (v: { id: string; version: number; previousId?: string }, ctx: z.RefinementCtx) => {
  if ((v.version === 1) !== !v.previousId || v.previousId === v.id) ctx.addIssue({ code: 'custom', path: ['previousId'], message: 'First version has no predecessor; later versions must name a different predecessor' });
};

export const Location = record({
  type: z.literal('location'), name: text, kind: LocationKind, parentId: ref.optional(), unitId: ref.optional(),
  active: z.boolean().default(true), revision: version.default(1), description: text.optional(),
  capacity: z.number().int().positive().optional(),
}).superRefine((v, ctx) => {
  if (v.parentId === v.id) ctx.addIssue({ code: 'custom', path: ['parentId'], message: 'A location cannot contain itself' });
  if (v.kind === 'bed' && v.capacity !== undefined && v.capacity !== 1) ctx.addIssue({ code: 'custom', path: ['capacity'], message: 'An individual bed has capacity one' });
});
export type Location = z.infer<typeof Location>;

export const ServiceDefinition = record({
  type: z.literal('service_definition'), name: text, category: ServiceCategory,
  investigation: z.strictObject({ specimen: text, department: text, aliases: z.array(text).max(50).default([]) }).optional(),
  concept: CodedConcept, orderable: z.boolean().default(false), active: z.boolean().default(true), revision: version.default(1),
});
export type ServiceDefinition = z.infer<typeof ServiceDefinition>;
export const ServiceOffering = record({
  type: z.literal('service_offering'), serviceDefinitionId: ref, unitId: ref, name: text,
  feeItemId: ref.optional(),
  locationIds: distinctRefs, delivery: z.enum(['physical', 'mobile', 'virtual']),
  requiredActions: z.array(ClinicalAction).max(ClinicalAction.options.length).default([])
    .refine((v) => new Set(v).size === v.length, 'Choose each action only once'),
  intakePolicy: z.enum(['walk_in', 'scheduled', 'both']), timeZone: FacilityTimeZone,
  configuration: z.enum(['draft', 'proposed', 'active', 'retired']), revision: version.default(1),
  resourceReadiness: z.enum(['unassessed', 'available', 'unavailable']).default('unassessed'),
}).refine((v) => v.delivery !== 'physical' || v.locationIds.length > 0, 'A physical offering needs an actual location');
export type ServiceOffering = z.infer<typeof ServiceOffering>;

export const PractitionerProfile = record({
  type: z.literal('practitioner_profile'), staffId: ref, profession: CodedConcept,
  specialties: z.array(CodedConcept).max(100).default([]), active: z.boolean().default(true), revision: version.default(1),
});
export type PractitionerProfile = z.infer<typeof PractitionerProfile>;
export const Credential = record({
  type: z.literal('credential'), credentialId: ref, ...revisionFields, staffId: ref,
  kind: z.enum(['licence', 'registration', 'qualification', 'training', 'other']), issuer: text, label: text,
  /** Restricted evidence, not part of the general staff-directory replica. */
  identifier: text.optional(), evidenceReference: text.optional(),
  issuedOn: FacilityDate.optional(), validThrough: FacilityDate.optional(),
  /** Valid-through includes the entire local calendar day in this zone. */
  timeZone: FacilityTimeZone, externalReviewerId: ref.optional(),
  verification: z.enum(['unverified', 'verified', 'rejected', 'withdrawn']),
  checkedBy: ref.optional(), checkedOn: FacilityInstant.optional(), reason: text.optional(),
}).superRefine((v, ctx) => {
  checkRevision(v, ctx);
  if (v.externalReviewerId && v.createdBy !== 'system') ctx.addIssue({ code: 'custom', message: 'External verification requires the audited server operation' });
  if (v.issuedOn && v.validThrough && v.validThrough < v.issuedOn) ctx.addIssue({ code: 'custom', path: ['validThrough'], message: 'Validity cannot end before issue' });
  if (v.verification === 'unverified' && (v.checkedBy || v.checkedOn)) ctx.addIssue({ code: 'custom', message: 'Unverified evidence cannot claim a reviewer' });
  if (v.verification !== 'unverified' && (!v.checkedOn || v.checkedBy !== v.createdBy || v.checkedBy === v.staffId)) ctx.addIssue({ code: 'custom', message: 'A review requires its independent author and actual check time' });
  if (v.verification === 'verified' && !v.evidenceReference) ctx.addIssue({ code: 'custom', path: ['evidenceReference'], message: 'Record the verified evidence source' });
  if (['rejected', 'withdrawn'].includes(v.verification) && !v.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Explain the decision' });
});
export type Credential = z.infer<typeof Credential>;

export const ClinicalGrant = z.strictObject({
  capabilityId: ref, decisionId: ref, scope: ClinicalScope, ...intervalFields,
  supervisorId: ref.optional(), independentCheck: z.boolean().default(false),
}).superRefine(checkInterval);
export type ClinicalGrant = z.infer<typeof ClinicalGrant>;
export const CapabilityDecision = record({
  type: z.literal('capability_decision'), capabilityId: ref, ...revisionFields,
  staffId: ref, scope: ClinicalScope, ...intervalFields,
  decision: z.enum(['approve', 'reject', 'restrict', 'suspend', 'revoke']), credentialRevisionIds: distinctRefs,
  externalReviewerId: ref.optional(),
  supervisorId: ref.optional(), independentCheck: z.boolean().default(false), reason: text,
}).superRefine((v, ctx) => {
  checkRevision(v, ctx); checkInterval(v, ctx);
  if (v.externalReviewerId && v.createdBy !== 'system') ctx.addIssue({ code: 'custom', message: 'External decisions require the audited server operation' });
  if (v.staffId === v.createdBy || v.supervisorId === v.staffId) ctx.addIssue({ code: 'custom', message: 'Self approval/supervision is not allowed' });
  if (['approve', 'restrict'].includes(v.decision) && !v.credentialRevisionIds.length) ctx.addIssue({ code: 'custom', path: ['credentialRevisionIds'], message: 'Approval requires reviewed evidence' });
  if (['restrict', 'suspend', 'revoke'].includes(v.decision) && !v.previousId) ctx.addIssue({ code: 'custom', message: 'This decision must reference the previous capability decision' });
});
export type CapabilityDecision = z.infer<typeof CapabilityDecision>;

export const ReviewerDelegation = record({
  type: z.literal('reviewer_delegation'), delegationId: ref, ...revisionFields,
  staffId: ref, scopes: z.array(ClinicalScope).min(1).max(100), ...intervalFields,
  decision: z.enum(['approve', 'revoke']), reason: text,
}).superRefine((v, ctx) => {
  checkRevision(v, ctx); checkInterval(v, ctx);
  if (v.staffId === v.createdBy) ctx.addIssue({ code: 'custom', message: 'A reviewer cannot delegate authority to themselves' });
  if (v.decision === 'revoke' && !v.previousId) ctx.addIssue({ code: 'custom', message: 'Revocation requires a predecessor' });
});
export type ReviewerDelegation = z.infer<typeof ReviewerDelegation>;
export const ClinicalAuthorityBootstrap = record({
  type: z.literal('clinical_authority_bootstrap'), createdBy: z.literal('system'),
  bootstrapId: ref, ...revisionFields, decision: z.enum(['approve', 'revoke']),
  staffId: ref, scopes: z.array(ClinicalScope).min(1).max(100), ...intervalFields,
  endsAt: FacilityInstant, governanceReference: text, authorizedBy: text, reason: text,
}).superRefine((v, ctx) => {
  checkInterval(v, ctx); checkRevision(v, ctx);
  if (v.decision === 'revoke' && !v.previousId) ctx.addIssue({ code: 'custom', message: 'Revoke an existing bootstrap authority explicitly' });
});
export type ClinicalAuthorityBootstrap = z.infer<typeof ClinicalAuthorityBootstrap>;
/** An actual external verifier; never an invented local Staff account. */
export const ExternalClinicalReviewer = record({
  type: z.literal('external_clinical_reviewer'), createdBy: z.literal('system'),
  externalSubjectReference: text, displayName: text, governanceReference: text, authorizedBy: text,
  scopes: z.array(ClinicalScope).min(1).max(100), ...intervalFields, endsAt: FacilityInstant,
  linkedStaffId: ref.optional(), active: z.boolean(), revision: version,
}).superRefine(checkInterval);
export type ExternalClinicalReviewer = z.infer<typeof ExternalClinicalReviewer>;
export const ReviewerGrant = z.strictObject({ decisionId: ref, scope: ClinicalScope, ...intervalFields }).superRefine(checkInterval);
export type ReviewerGrant = z.infer<typeof ReviewerGrant>;
export const AuthoritySnapshot = record({
  type: z.literal('authority_snapshot'), createdBy: z.literal('system'), staffId: ref,
  revision: version, policyVersion: z.number().int().min(FACILITY_MIN_POLICY_VERSION),
  issuedOn: FacilityInstant, expiresOn: FacilityInstant,
  grants: z.array(ClinicalGrant).max(1000),
  reviewScopes: z.array(ReviewerGrant).max(100).default([]),
  sourceDecisionIds: distinctRefs, keyId: ref, signature: ref,
}).superRefine((v, ctx) => {
  const duration = Date.parse(v.expiresOn) - Date.parse(v.issuedOn);
  if (duration <= 0 || duration > 7 * 24 * 60 * 60 * 1000) ctx.addIssue({ code: 'custom', path: ['expiresOn'], message: 'Authority proof must expire within seven days of issue' });
  if (new Set(v.grants.map((g) => g.capabilityId)).size !== v.grants.length) ctx.addIssue({ code: 'custom', message: 'Each capability has one effective grant' });
  if (v.grants.some((g) => !v.sourceDecisionIds.includes(g.decisionId) || g.supervisorId === v.staffId)) ctx.addIssue({ code: 'custom', message: 'Grants need source decisions and independent supervision' });
  if (v.reviewScopes.some((s) => !v.sourceDecisionIds.includes(s.decisionId))) ctx.addIssue({ code: 'custom', message: 'Reviewer authority needs an explicit source decision' });
});
export type AuthoritySnapshot = z.infer<typeof AuthoritySnapshot>;

/** Canonical signed bytes. Consumers perform crypto verification with a trusted key. */
export const authoritySignaturePayload = (v: Omit<AuthoritySnapshot, 'signature'> | AuthoritySnapshot): string => JSON.stringify({
  purpose: 'geneus:clinical-authority:v1',
  id: v.id, facilityId: v.facilityId, staffId: v.staffId, revision: v.revision, policyVersion: v.policyVersion,
  issuedOn: Date.parse(v.issuedOn), expiresOn: Date.parse(v.expiresOn), keyId: v.keyId,
  grants: [...v.grants].sort((a, b) => compare(a.capabilityId, b.capabilityId)).map((g) => ({
    capabilityId: g.capabilityId, decisionId: g.decisionId,
    scope: canonicalScope(g.scope), startsAt: Date.parse(g.startsAt), endsAt: g.endsAt ? Date.parse(g.endsAt) : null,
    supervisorId: g.supervisorId ?? null, independentCheck: g.independentCheck,
  })), reviewScopes: v.reviewScopes.map((g) => ({ decisionId: g.decisionId, scope: canonicalScope(g.scope), startsAt: Date.parse(g.startsAt), endsAt: g.endsAt ? Date.parse(g.endsAt) : null }))
    .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
  sourceDecisionIds: [...v.sourceDecisionIds].sort(),
});
const canonicalScope = (s: z.infer<typeof ClinicalScope>) => ({ kind: s.kind, actions: [...s.actions].sort(), offeringIds: s.kind === 'offerings' ? [...s.offeringIds].sort() : [] });
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export const StaffAssignment = record({
  type: z.literal('staff_assignment'), assignmentId: ref, ...revisionFields,
  staffId: ref, offeringId: ref, locationIds: distinctRefs, ...intervalFields,
  duty: z.enum(['lead', 'member', 'supervisor', 'on_call', 'support']),
  requiredActions: z.array(ClinicalAction).max(ClinicalAction.options.length).default([])
    .refine((v) => new Set(v).size === v.length, 'Choose each action only once'),
  status: z.enum(['proposed', 'active', 'suspended', 'ended']), supervisorId: ref.optional(),
  temporaryCover: z.boolean().default(false), coveringAssignmentId: ref.optional(), reason: text.optional(),
}).superRefine((v, ctx) => {
  checkRevision(v, ctx); checkInterval(v, ctx);
  if (v.supervisorId === v.staffId || v.coveringAssignmentId === v.assignmentId) ctx.addIssue({ code: 'custom', message: 'A worker cannot supervise or cover themselves' });
  if (v.temporaryCover && (!v.endsAt || !v.reason)) ctx.addIssue({ code: 'custom', message: 'Temporary cover needs an end and reason' });
  if (v.coveringAssignmentId && !v.temporaryCover) ctx.addIssue({ code: 'custom', message: 'A covered assignment requires temporary cover' });
  if (v.status === 'ended' && !v.endsAt) ctx.addIssue({ code: 'custom', message: 'Ended assignments need an effective end' });
});
export type StaffAssignment = z.infer<typeof StaffAssignment>;

export const ServiceSession = record({
  type: z.literal('service_session'), sessionId: ref, ...revisionFields, offeringId: ref,
  startsAt: FacilityInstant, endsAt: FacilityInstant, timeZone: FacilityTimeZone,
  status: z.enum(['draft', 'published', 'cancelled']), seriesId: ref.optional(),
  participants: z.array(z.strictObject({ assignmentId: ref, staffId: ref, commitment: z.enum(['exclusive', 'shared', 'on_call']) })).min(1).max(1000),
  resources: z.array(z.strictObject({ locationId: ref, mode: z.enum(['exclusive', 'pooled']), units: z.number().int().positive() })).max(100).default([]),
  maxAppointments: z.number().int().positive().optional(), rosterShiftIds: distinctRefs.default([]), reason: text.optional(),
}).superRefine((v, ctx) => {
  checkRevision(v, ctx); checkInterval(v, ctx);
  if (new Set(v.participants.map((p) => p.staffId)).size !== v.participants.length || new Set(v.resources.map((r) => r.locationId)).size !== v.resources.length) ctx.addIssue({ code: 'custom', message: 'Choose each worker and resource only once per session' });
  if (v.status === 'cancelled' && !v.reason) ctx.addIssue({ code: 'custom', message: 'Explain cancellation' });
});
export type ServiceSession = z.infer<typeof ServiceSession>;
export const SessionEvent = record({
  type: z.literal('session_event'), offeringId: ref, sessionId: ref.optional(), previousId: ref.optional(),
  action: z.enum(['open', 'pause', 'resume', 'close']), observedOn: FacilityInstant, reason: text.optional(),
}).superRefine((v, ctx) => {
  if (v.previousId === v.id || (v.action !== 'open' && !v.previousId)) ctx.addIssue({ code: 'custom', message: 'Intake changes require their preceding event' });
  if (['pause', 'close'].includes(v.action) && !v.reason) ctx.addIssue({ code: 'custom', message: 'Explain the intake change' });
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const WorkOwnershipEvent = record({
  type: z.literal('work_ownership_event'), sourceType: z.literal('handoff'), sourceId: ref,
  patientId, offeringId: ref, previousId: ref.optional(),
  action: z.enum(['claim', 'offer_transfer', 'accept_transfer', 'decline_transfer', 'release']),
  ownerStaffId: ref.optional(), recipientStaffId: ref.optional(), reason: text.optional(),
}).superRefine((v, ctx) => {
  if (v.previousId === v.id || (v.action !== 'claim' && !v.previousId)) ctx.addIssue({ code: 'custom', message: 'Ownership changes require a different predecessor' });
  if (v.action === 'claim' && v.ownerStaffId !== v.createdBy) ctx.addIssue({ code: 'custom', message: 'Claim only for the acting worker' });
  if (v.action === 'accept_transfer' && v.ownerStaffId !== v.createdBy) ctx.addIssue({ code: 'custom', message: 'Acceptance must name the acting recipient as owner' });
  if (v.action === 'offer_transfer' && (!v.recipientStaffId || v.recipientStaffId === v.ownerStaffId || !v.ownerStaffId)) ctx.addIssue({ code: 'custom', message: 'Choose a different receiving worker' });
  if (v.action === 'release' && v.ownerStaffId) ctx.addIssue({ code: 'custom', message: 'Released work returns to its service without an individual owner' });
  if (v.action !== 'offer_transfer' && v.recipientStaffId) ctx.addIssue({ code: 'custom', message: 'Only transfer offers carry a proposed recipient' });
  if (v.action !== 'claim' && !v.reason) ctx.addIssue({ code: 'custom', message: 'Explain the ownership change' });
});
export type WorkOwnershipEvent = z.infer<typeof WorkOwnershipEvent>;

export const AppointmentReservation = record({
  type: z.literal('appointment_reservation'), createdBy: z.literal('system'), appointmentId: ref,
  patientId, offeringId: ref, allocationFingerprint: z.string().min(1).max(20000),
  status: z.enum(['accepted', 'conflict', 'released']), revision: version, reason: text.optional(),
}).refine((v) => v.status === 'accepted' || Boolean(v.reason), 'Explain a conflict or release');
export type AppointmentReservation = z.infer<typeof AppointmentReservation>;

export { Interval, ClinicalActions };
