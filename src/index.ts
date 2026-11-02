/**
 * Geneus Health — shared contract: public entry point.
 *
 * Import everything from here:
 *   import { Patient, AnyDocument, parseDocument } from '<path-to-submodule>/src';
 *
 * This is a plain git-submodule folder (no package.json). The consuming repo
 * supplies `zod` and its own tsconfig. Relative imports carry an explicit `.ts`
 * extension so both consumers resolve them: Vite in geneus-web, and Node's own
 * type stripping in geneus-server. See README.md.
 */
import { z } from 'zod';
import type { DocType } from './common.ts';

export * from './common.ts';
export * from './careWorkflow.ts';
export * from './documents.ts';
export * from './permissions.ts';
export * from './api.ts';
export * from './patientIdentity.ts';
export * from './clinical.ts';
export * from './inpatient.ts';
export * from './clinicalDocuments.ts';
export * from './resultTemplates.ts';
export * from './registers.ts';
export * from './facilityTypes.ts';
export * from './facility.ts';
export * from './facilityPolicy.ts';
export * from './facilitySync.ts';
export * from './facilityValidation.ts';
export * from './facilityAuthorization.ts';
export * from './facilityProjection.ts';

import { Location, ServiceDefinition, ServiceOffering, PractitionerProfile, Credential, CapabilityDecision,
  ReviewerDelegation, ClinicalAuthorityBootstrap, ExternalClinicalReviewer, AuthoritySnapshot,
  StaffAssignment, ServiceSession, SessionEvent, WorkOwnershipEvent, AppointmentReservation } from './facility.ts';

import { ClinicalEvent } from './clinical.ts';
import { InpatientEvent, BedReadyEvent } from './inpatient.ts';
import { LibraryDocument, VisitDocument } from './clinicalDocuments.ts';
import { ResultTemplate, ResultPartDefinition, AnswerList } from './resultTemplates.ts';

import {
  Patient,
  PatientIdentityEvent,
  Visit,
  Encounter,
  EncounterEntry,
  Handoff,
  Appointment,
  RegisterDefinition,
  RegisterEntry,
  Referral, InboundReferral,
  StockItem,
  StockMovement,
  Facility,
  Unit,
  Staff,
  RosterShift,
  Device,
  AuditEvent,
  SyncRejection,
  PinSetupCode,
  FeeItem,
  Charge,
  Payment,
  BillingAdjustment,
  IncomingTransfer,
  BillingDepartment,
} from './documents.ts';

/**
 * The union of every synced record. Kept a plain `z.union` (not a
 * discriminated union) for simplicity — validation just tries each member. When
 * you already know the `type`, prefer the specific schema via `parseDocument`.
 * Note a `register_entry`'s per-field rules are validated separately, against its
 * register definition — see `validateRegisterEntry` (documents.ts).
 */
export const AnyDocument = z.union([
  Location, ServiceDefinition, ServiceOffering, PractitionerProfile, Credential, CapabilityDecision,
  ReviewerDelegation, ClinicalAuthorityBootstrap, ExternalClinicalReviewer, AuthoritySnapshot,
  StaffAssignment, ServiceSession, SessionEvent, WorkOwnershipEvent, AppointmentReservation,
  ClinicalEvent,
  InpatientEvent, BedReadyEvent,
  LibraryDocument, VisitDocument,
  ResultTemplate, ResultPartDefinition, AnswerList,
  Patient,
  PatientIdentityEvent,
  Visit,
  Encounter,
  EncounterEntry,
  Handoff,
  Appointment,
  RegisterDefinition,
  RegisterEntry,
  Referral, InboundReferral,
  StockItem,
  StockMovement,
  Facility,
  Unit,
  Staff,
  RosterShift,
  Device,
  AuditEvent,
  SyncRejection,
  PinSetupCode,
  FeeItem,
  Charge,
  Payment,
  BillingAdjustment,
  IncomingTransfer,
  BillingDepartment,
]);
export type AnyDocument = z.infer<typeof AnyDocument>;

/** Map of `type` → schema, for validating a record when its type is known. */
export const SCHEMA_BY_TYPE = {
  location: Location, service_definition: ServiceDefinition, service_offering: ServiceOffering,
  practitioner_profile: PractitionerProfile, credential: Credential, capability_decision: CapabilityDecision,
  reviewer_delegation: ReviewerDelegation, clinical_authority_bootstrap: ClinicalAuthorityBootstrap,
  external_clinical_reviewer: ExternalClinicalReviewer, authority_snapshot: AuthoritySnapshot,
  staff_assignment: StaffAssignment, service_session: ServiceSession, session_event: SessionEvent,
  work_ownership_event: WorkOwnershipEvent, appointment_reservation: AppointmentReservation,
  clinical_event: ClinicalEvent,
  inpatient_event: InpatientEvent, bed_ready_event: BedReadyEvent,
  library_document: LibraryDocument, visit_document: VisitDocument,
  result_template: ResultTemplate, result_part: ResultPartDefinition, answer_list: AnswerList,
  patient: Patient,
  patient_identity_event: PatientIdentityEvent,
  visit: Visit,
  encounter: Encounter,
  encounter_entry: EncounterEntry,
  handoff: Handoff,
  appointment: Appointment,
  register_definition: RegisterDefinition,
  register_entry: RegisterEntry,
  referral: Referral,
  inbound_referral: InboundReferral,
  stock_item: StockItem,
  stock_movement: StockMovement,
  facility: Facility,
  unit: Unit,
  staff: Staff,
  roster_shift: RosterShift,
  device: Device,
  audit_event: AuditEvent,
  sync_rejection: SyncRejection,
  pin_setup_code: PinSetupCode,
  fee_item: FeeItem,
  charge: Charge,
  payment: Payment,
  billing_adjustment: BillingAdjustment,
  incoming_transfer: IncomingTransfer,
  billing_department: BillingDepartment,
} as const satisfies Record<DocType, z.ZodType>;

/**
 * Validate an unknown value as a record. If it carries a known `type`, the
 * matching schema is used for precise errors; otherwise it falls back to the
 * full union. Returns Zod's SafeParseReturn — the caller decides how to react
 * (reject the write, queue for the reconcile queue, etc.).
 *
 * Use this on EVERY write path (geneus-web before the SQLite write,
 * geneus-server on upload) — a bad record written offline may not surface until
 * it syncs, up to 7 days later (root §4.3).
 */
export function parseDocument(input: unknown) {
  const type = (input as { type?: unknown })?.type;
  if (typeof type === 'string' && Object.hasOwn(SCHEMA_BY_TYPE, type)) {
    return SCHEMA_BY_TYPE[type as keyof typeof SCHEMA_BY_TYPE].safeParse(input);
  }
  return AnyDocument.safeParse(input);
}
