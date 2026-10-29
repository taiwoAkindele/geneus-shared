/** Shared vocabulary only: no database, signing implementation or UI dependencies. */
import { z } from 'zod';
import { DocType, isoDate, isoDateTime } from './common.ts';

export const FACILITY_CONTRACT_VERSION = 1 as const;
export const FACILITY_MIN_SCHEMA_VERSION = 4 as const;
export const FACILITY_MIN_POLICY_VERSION = 10 as const;
export const facilityText = z.string().trim().min(1).max(500);
export const facilityIdRef = z.string().trim().min(1).max(200);
export const FacilityInstant = isoDateTime.refine((v) => Number.isFinite(Date.parse(v)), 'Enter a valid instant');
export const FacilityDate = isoDate.refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, 'Enter a valid calendar date');
export const FacilityTimeZone = z.string().refine((value) => {
  if (/^[+-]/.test(value)) return false; // An offset is not an IANA timezone with DST/calendar rules.
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Choose a supported IANA time zone');
export const distinctRefs = z.array(facilityIdRef).max(1000).refine((v) => new Set(v).size === v.length, 'Choose each reference only once');
export const FacilityDependency = z.strictObject({ table: DocType, id: facilityIdRef });
export type FacilityDependency = z.infer<typeof FacilityDependency>;
export const OrganizationKind = z.enum(['department', 'unit']);
export type OrganizationKind = z.infer<typeof OrganizationKind>;
export const LocationKind = z.enum(['site', 'building', 'room', 'ward', 'bed', 'store', 'service_point', 'mobile', 'virtual']);
export const ServiceCategory = z.enum(['consultation', 'nursing', 'laboratory', 'pharmacy', 'procedure', 'preventive', 'rehabilitation', 'other']);
export const ClinicalAction = z.enum(['assess', 'diagnose', 'prescribe', 'collect_specimen', 'perform_test', 'record_result', 'verify_result', 'release_result', 'dispense', 'administer']);
export type ClinicalAction = z.infer<typeof ClinicalAction>;
export const ClinicalActions = z.array(ClinicalAction).min(1).max(ClinicalAction.options.length)
  .refine((v) => new Set(v).size === v.length, 'Choose each clinical action only once');
export const ClinicalScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('facility'), actions: ClinicalActions }),
  z.strictObject({ kind: z.literal('offerings'), actions: ClinicalActions, offeringIds: distinctRefs.refine((v) => v.length > 0, 'Choose an offering') }),
]);
export type ClinicalScope = z.infer<typeof ClinicalScope>;
export const CodedConcept = z.strictObject({ system: facilityText, code: facilityText, label: facilityText, version: facilityText.optional() });

export const Interval = z.strictObject({ startsAt: FacilityInstant, endsAt: FacilityInstant.optional() })
  .refine((v) => !v.endsAt || Date.parse(v.endsAt) > Date.parse(v.startsAt), 'End must be after start');
export type Interval = z.infer<typeof Interval>;
export const intervalContains = (interval: Interval, at: number): boolean => Number.isFinite(at)
  && at >= Date.parse(interval.startsAt) && (!interval.endsAt || at < Date.parse(interval.endsAt));
export const intervalsOverlap = (a: Interval, b: Interval): boolean =>
  Date.parse(a.startsAt) < (b.endsAt ? Date.parse(b.endsAt) : Infinity)
  && Date.parse(b.startsAt) < (a.endsAt ? Date.parse(a.endsAt) : Infinity);
export const scopeAllows = (scope: ClinicalScope, action: ClinicalAction, offeringId: string): boolean =>
  scope.actions.includes(action) && (scope.kind === 'facility' || scope.offeringIds.includes(offeringId));
export const scopeContains = (authority: ClinicalScope, requested: ClinicalScope): boolean =>
  requested.actions.every((action) => authority.actions.includes(action))
  && (authority.kind === 'facility' || (requested.kind === 'offerings' && requested.offeringIds.every((id) => authority.offeringIds.includes(id))));

/** Booking allocation is a proposal, never proof of an accepted reservation. */
export const AppointmentAllocation = z.strictObject({
  offeringId: facilityIdRef, sessionId: facilityIdRef.optional(), assignmentId: facilityIdRef.optional(),
  staffId: facilityIdRef.optional(), endsAt: FacilityInstant,
  locations: z.array(z.strictObject({ locationId: facilityIdRef, units: z.number().int().positive() })).max(100).default([]),
}).superRefine((v, ctx) => {
  if (Boolean(v.staffId) !== Boolean(v.assignmentId)) ctx.addIssue({ code: 'custom', message: 'A named practitioner needs their assignment and vice versa' });
  if (new Set(v.locations.map((r) => r.locationId)).size !== v.locations.length) ctx.addIssue({ code: 'custom', message: 'Choose each location only once' });
});
export type AppointmentAllocation = z.infer<typeof AppointmentAllocation>;

/** Immutable attribution to the accepted authority/assignment used at the time. */
export const ClinicalActorContext = z.strictObject({
  offeringId: facilityIdRef, authoritySnapshotId: facilityIdRef,
  assignmentRevisionId: facilityIdRef.optional(), locationId: facilityIdRef.optional(),
});
export type ClinicalActorContext = z.infer<typeof ClinicalActorContext>;

/** Server-owned cutover marker; absence means legacy/preparation, never implicit enforcement. */
export const FacilityWorkforcePolicy = z.strictObject({
  contractVersion: z.literal(FACILITY_CONTRACT_VERSION), schemaVersion: z.literal(FACILITY_MIN_SCHEMA_VERSION),
  policyVersion: z.literal(FACILITY_MIN_POLICY_VERSION), revision: z.number().int().positive(),
  mode: z.enum(['preparation', 'enforced']), effectiveOn: FacilityInstant.optional(), governanceReference: facilityText,
}).refine((v) => v.mode !== 'enforced' || Boolean(v.effectiveOn), 'Enforcement requires an explicit effective instant');
export type FacilityWorkforcePolicy = z.infer<typeof FacilityWorkforcePolicy>;
export const workforceEnforcementActive = (policy: FacilityWorkforcePolicy | undefined, at: number): boolean =>
  Boolean(policy?.mode === 'enforced' && policy.effectiveOn && Number.isFinite(at) && at >= Date.parse(policy.effectiveOn));

export const FACILITY_DOCUMENT_TYPES = [
  'location', 'service_definition', 'service_offering', 'practitioner_profile', 'credential',
  'capability_decision', 'reviewer_delegation', 'clinical_authority_bootstrap', 'authority_snapshot', 'external_clinical_reviewer',
  'staff_assignment', 'service_session', 'session_event', 'work_ownership_event', 'appointment_reservation',
] as const;
export type FacilityDocumentType = (typeof FACILITY_DOCUMENT_TYPES)[number];
export const RESTRICTED_FACILITY_DOCUMENT_TYPES = ['credential', 'capability_decision', 'reviewer_delegation', 'clinical_authority_bootstrap', 'external_clinical_reviewer'] as const;
