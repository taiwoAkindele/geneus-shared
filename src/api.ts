/**
 * Geneus Health — shared contract: the geneus-server API.
 *
 * Request and response shapes for the handful of things that must happen
 * online: registering a facility, enrolling a device, minting a sync token,
 * and uploading the device's queued mutations. Everything clinical goes
 * through SQLite → PowerSync, not through these.
 *
 * Only shapes live here. Route handlers belong to geneus-server; the API client
 * belongs to geneus-web (`src/lib/api`).
 */
import { z } from 'zod';
import { DocType, isoDateTime } from './common.ts';
import { Facility, Staff, SyncOperation, RejectionCategory, Patient } from './documents.ts';
import { FACILITY_CONTRACT_VERSION, FacilityDependency } from './facilityTypes.ts';
import { FacilityFeatureSupport } from './facilityPolicy.ts';
import { requiresFacilityContract } from './facilitySync.ts';

export const PatientIdentityPreview = z.object({
  revision: z.string(), canonicalPatientId: z.string(), otherRootId: z.string(),
  records: z.array(z.object({ patient: Patient, counts: z.object({ encounters: z.number(), appointments: z.number(), charges: z.number(), payments: z.number() }) })),
  retainedIds: z.array(z.string()), otherIds: z.array(z.string()), warning: z.string(),
});
export type PatientIdentityPreview = z.infer<typeof PatientIdentityPreview>;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Every non-2xx response carries this body; `issues` only for validation. */
export const ApiErrorBody = z.object({
  error: z.string().min(1),
  message: z.string().min(1),
  issues: z.array(z.unknown()).optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/* ------------------------------------------------------------------ */
/* Facility registration — GET /invites/:token · POST /facilities      */
/* ------------------------------------------------------------------ */

export const InviteCheck = z.object({
  label: z.string().min(1),
  expiresOn: isoDateTime,
});
export type InviteCheck = z.infer<typeof InviteCheck>;

/** Facility codes build every Patient ID, so the format is fixed here. */
export const facilityCode = z
  .string()
  .min(2)
  .max(20)
  .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'Use uppercase letters, digits and hyphens');

/** An email address as it is stored and compared: trimmed and lower-case. */
export const emailAddress = z.string().trim().toLowerCase().pipe(z.email());

/** The 6-digit code that proves someone can read an email address. */
export const emailCode = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email');

export const FacilityRegistration = z.object({
  code: facilityCode,
  name: z.string().min(1),
  state: z.string().min(1),
  lga: z.string().min(1),
  level: Facility.shape.level,
  adminFullName: z.string().min(1),
  /**
   * The first admin's email, proven with `emailCode` from
   * `POST /email-verifications`. Kept on the server only — never a synced
   * record — and used for one thing: emailing them a PIN setup code if they
   * forget their PIN (SCHEMA.md §10).
   */
  adminEmail: emailAddress,
  emailCode,
  /** Minted on the device before it has any other identity; becomes `devices.id`. */
  deviceId: z.string().min(1),
  deviceLabel: z.string().optional(),
  inviteToken: z.string().min(1),
});
export type FacilityRegistration = z.infer<typeof FacilityRegistration>;

/**
 * What an enrolled device holds. `credential` is shown exactly once — the
 * server keeps only a hash — and is the device's proof of identity for
 * `POST /sync/token`. It is facility-scoped and revocable; it says nothing
 * about which human is using the device (root §4.3a).
 */
export const DeviceCredential = z.object({
  deviceId: z.string().min(1),
  facilityId: z.string().min(1),
  credential: z.string().min(1),
  /** Where the device connects PowerSync to; server configuration, not a client constant. */
  syncEndpoint: z.url(),
});
export type DeviceCredential = z.infer<typeof DeviceCredential>;

export const FacilityRegistrationResult = z.object({
  facility: Facility,
  admin: Staff,
  device: DeviceCredential,
});
export type FacilityRegistrationResult = z.infer<typeof FacilityRegistrationResult>;

/** The same facility details are collected for primary and additional facilities. */
export const FacilityDetails = FacilityRegistration.pick({ code: true, name: true, state: true, lga: true, level: true });
export type FacilityDetails = z.infer<typeof FacilityDetails>;

/** Reuses the authenticated administrator's verified contact, never a client-supplied email. */
export const OrganizationFacilityRegistration = FacilityDetails.extend({
  actorStaffId: z.string().min(1),
  organizationId: z.string().min(1).optional(),
  organizationName: z.string().trim().min(1).max(200).optional(),
  requestId: z.uuid(),
  deviceId: z.uuid(),
  deviceLabel: z.string().max(200).optional(),
  /** Client-generated 256-bit enrollment secret permits safe retries after a lost response. */
  deviceSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).refine((value) => Boolean(value.organizationId || value.organizationName), { path: ['organizationName'], message: 'Enter the organization name' });
export type OrganizationFacilityRegistration = z.infer<typeof OrganizationFacilityRegistration>;

export const OrganizationFacilityDefaults = z.object({
  organization: z.object({ id: z.string(), name: z.string() }).nullable(),
  administrator: z.object({ staffId: z.string(), fullName: z.string(), verifiedEmail: z.string().nullable() }),
});
export type OrganizationFacilityDefaults = z.infer<typeof OrganizationFacilityDefaults>;

export const OrganizationFacilityResult = FacilityRegistrationResult.extend({ organization: z.object({ id: z.string(), name: z.string() }) });
export type OrganizationFacilityResult = z.infer<typeof OrganizationFacilityResult>;

export const OrganizationFacilityDirectory = z.object({
  organization: z.object({ id: z.string(), name: z.string() }).nullable(),
  canCreateFacility: z.boolean(),
  facilities: z.array(z.object({ id: z.string(), name: z.string(), accessible: z.boolean(), canEnrollDevice: z.boolean() })),
});
export type OrganizationFacilityDirectory = z.infer<typeof OrganizationFacilityDirectory>;

export const OrganizationFacilityOpen = z.object({ actorStaffId: z.string().min(1), facilityId: z.string().min(1), deviceId: z.string().min(1).max(200), deviceSecret: OrganizationFacilityRegistration.shape.deviceSecret.optional() });
export type OrganizationFacilityOpen = z.infer<typeof OrganizationFacilityOpen>;
export const OrganizationFacilityAccess = z.object({
  facilityId: z.string(), staffId: z.string(), personId: z.string(),
  device: DeviceCredential.optional(),
});
export type OrganizationFacilityAccess = z.infer<typeof OrganizationFacilityAccess>;

/* ------------------------------------------------------------------ */
/* Device enrollment — POST /devices/codes · POST /devices · POST /devices/:id/revoke */
/* ------------------------------------------------------------------ */

/**
 * An already-enrolled device, with a signed-in `device:enroll` holder, asks for
 * a short code and reads it out to the joining device. The code is single-use
 * and short-lived; the joining device spends it for its own credential.
 */
export const EnrollmentCodeRequest = z.object({
  /** Staff issuing the code — verified server-side against the device's facility. */
  issuedBy: z.string().min(1),
});
export type EnrollmentCodeRequest = z.infer<typeof EnrollmentCodeRequest>;

export const EnrollmentCode = z.object({
  code: z.string().min(1),
  expiresOn: isoDateTime,
});
export type EnrollmentCode = z.infer<typeof EnrollmentCode>;

export const DeviceEnrollmentRequest = z.object({
  code: z.string().min(1),
  deviceId: z.string().min(1),
  deviceLabel: z.string().optional(),
});
export type DeviceEnrollmentRequest = z.infer<typeof DeviceEnrollmentRequest>;

export const DeviceRevocationRequest = z.object({
  /** Staff revoking — verified server-side to hold `device:revoke`. */
  revokedBy: z.string().min(1),
  /** True asks the device to drop its local replica on next contact. */
  wipe: z.boolean().default(true),
});
export type DeviceRevocationRequest = z.infer<typeof DeviceRevocationRequest>;

/* ------------------------------------------------------------------ */
/* Email verification — POST /email-verifications                      */
/*   POST /staff/:staffId/email/code · POST /staff/:staffId/email      */
/* ------------------------------------------------------------------ */

/**
 * Before registering, the would-be admin proves their email: the server emails
 * a 6-digit code, which goes back with the registration. The invite token is
 * required so the endpoint cannot be used to send mail to anyone.
 */
export const RegistrationEmailRequest = z.object({
  email: emailAddress,
  inviteToken: z.string().min(1),
});
export type RegistrationEmailRequest = z.infer<typeof RegistrationEmailRequest>;

/**
 * A facility admin adding or changing their own recovery email, from an
 * enrolled device. The server knows the device, not the person holding it, so
 * replacing an email already on file also needs a code sent to that current
 * address — otherwise whoever holds a facility phone could redirect an admin's
 * recovery to themselves.
 */
export const StaffEmailRequest = z.object({
  email: emailAddress,
  /** Must be the admin named in the path — an admin sets only their own email. */
  requestedBy: z.string().min(1),
});
export type StaffEmailRequest = z.infer<typeof StaffEmailRequest>;

export const StaffEmailConfirmation = StaffEmailRequest.extend({
  /** From the email sent to the new address. */
  code: emailCode,
  /** From the email sent to the address already on file; required when there is one. */
  currentCode: emailCode.optional(),
});
export type StaffEmailConfirmation = z.infer<typeof StaffEmailConfirmation>;

/** Where a code was emailed, masked (`a•••@gmail.com`) — the address itself is never sent back. */
export const EmailSent = z.object({
  sentTo: z.string().min(1),
  /** When an email is being replaced: where the second code went (the address on file), masked. */
  currentSentTo: z.string().min(1).optional(),
  expiresOn: isoDateTime,
});
export type EmailSent = z.infer<typeof EmailSent>;

/* ------------------------------------------------------------------ */
/* PIN setup codes — POST /staff/:staffId/pin-codes                    */
/*   POST /staff/:staffId/pin-codes/email (a facility admin, by email) */
/* ------------------------------------------------------------------ */

/**
 * An admin, from any enrolled device, asks for a code that lets a member of
 * staff set (or reset) their PIN on a facility device. The plain code is in
 * this response only; the `pin_setup_code` record that syncs down carries its
 * hash. Read it to the staff member by phone — nothing else delivers it.
 */
export const PinSetupCodeRequest = z.object({
  /** Staff issuing the code — verified server-side to hold `staff:manage`. */
  issuedBy: z.string().min(1),
});
export type PinSetupCodeRequest = z.infer<typeof PinSetupCodeRequest>;

export const PinSetupCodeIssued = z.object({
  code: z.string().min(1),
  expiresOn: isoDateTime,
});
export type PinSetupCodeIssued = z.infer<typeof PinSetupCodeIssued>;

/* ------------------------------------------------------------------ */
/* Sync token — POST /sync/token (Authorization: Bearer <credential>)  */
/* ------------------------------------------------------------------ */

/**
 * A short-lived JWT for PowerSync, minted from the long-lived device
 * credential. Its subject is the device, its `facility_id` claim drives the
 * Sync Streams. A device only needs one while online, so the short expiry
 * costs offline operation nothing.
 */
export const SyncTokenResponse = z.object({
  token: z.string().min(1),
  expiresOn: isoDateTime,
  syncEndpoint: z.url(),
  /** Server clock at issue — the device records it as lastServerContactOn. */
  serverTime: isoDateTime,
  /** Omitted until the server has implemented/migrated this feature. Never infer support from a version alone. */
  facilityFeature: FacilityFeatureSupport.optional(),
  inpatientWorkflowVersion: z.literal(1).optional(),
  documentWorkflowVersion: z.literal(1).optional(),
});
export type SyncTokenResponse = z.infer<typeof SyncTokenResponse>;

/** The claims geneus-server puts in the token; PowerSync reads `facility_id`. */
export const SyncTokenClaims = z.object({
  sub: z.string().min(1),
  aud: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  facility_id: z.string().min(1),
  facility_contract: z.literal(1).optional(),
  clinical_workflow: z.literal(1).optional(),
  patient_registration: z.literal(1).optional(),
  inpatient_workflow: z.literal(1).optional(),
  document_workflow: z.literal(1).optional(),
});
export type SyncTokenClaims = z.infer<typeof SyncTokenClaims>;

/* ------------------------------------------------------------------ */
/* Upload — POST /sync/upload (Authorization: Bearer <credential>)     */
/* ------------------------------------------------------------------ */

/**
 * One queued local write, as PowerSync hands it to the connector. `table` is
 * the record `type`; `data` is the full record for `put` and only the changed
 * fields (plus `id`) for `patch`. `clientId` is PowerSync's per-device
 * sequence number and, with `transactionId`, the mutation's stable identity
 * (root §12).
 */
export const UploadMutation = z.object({
  clientId: z.number().int().nonnegative(),
  op: SyncOperation,
  table: DocType,
  id: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  /**
   * The columns' values before this device changed them, when the client
   * tracked them. This is what lets the server tell "both changed column X"
   * from "only I changed column X" (SCHEMA.md §7).
   */
  previous: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().positive().optional(),
  /** Null means create a new stream; a string must still be the current accepted head. */
  expectedPreviousId: z.string().min(1).nullable().optional(),
});
export type UploadMutation = z.infer<typeof UploadMutation>;

export const UploadRequest = z.object({
  documentWorkflowVersion: z.literal(1).optional(),
  inpatientWorkflowVersion: z.literal(1).optional(),
  clinicalWorkflowVersion: z.literal(1).optional(),
  /** PowerSync's local transaction id; null when the write was not transactional. */
  transactionId: z.number().int().nonnegative().nullable(),
  mutations: z.array(UploadMutation).min(1),
  facilityContractVersion: z.literal(FACILITY_CONTRACT_VERSION).optional(),
  schemaVersion: z.number().int().positive().optional(),
  policyVersion: z.number().int().positive().optional(),
}).superRefine((request, context) => {
  if(request.mutations.some((mutation)=>['library_document','visit_document'].includes(mutation.table)) && (request.documentWorkflowVersion!==1 || request.facilityContractVersion!==1 || (request.schemaVersion??0)<5 || (request.policyVersion??0)<11)) context.addIssue({code:'custom',message:'Document writes require document workflow 1, facility contract 1, schema 5 and policy 11'});
  if (request.mutations.some((mutation) => ['inpatient_event', 'bed_ready_event'].includes(mutation.table) || (mutation.table === 'staff' && Array.isArray(mutation.data.additionalPermissions) && mutation.data.additionalPermissions.includes('admission:manage'))) && (request.inpatientWorkflowVersion !== 1 || request.facilityContractVersion !== 1 || (request.schemaVersion ?? 0) < 5 || (request.policyVersion ?? 0) < 11)) context.addIssue({ code: 'custom', message: 'Inpatient writes require inpatient workflow 1, facility contract 1, schema 5 and policy 11' });
  if (request.clinicalWorkflowVersion === 1 && (request.facilityContractVersion !== 1 || (request.schemaVersion ?? 0) < 4 || (request.policyVersion ?? 0) < 10)) context.addIssue({ code: 'custom', message: 'Clinical workflow v1 requires facility contract 1, schema 4 and policy 10' });
  if (request.mutations.some((m) => m.table === 'encounter_entry' && (m.data.workflowVersion === 1 || ['investigation_review','result_review','prescription','injection_order','disposition'].includes(String(m.data.step)))) && request.clinicalWorkflowVersion !== 1) context.addIssue({ code: 'custom', message: 'New care entries require clinical workflow version one' });
  if (request.mutations.some(requiresFacilityContract) && (request.facilityContractVersion !== 1 || (request.schemaVersion ?? 0) < 4 || (request.policyVersion ?? 0) < 10)) context.addIssue({ code: 'custom', message: 'Facility writes require the negotiated v1 contract, schema 4 and policy 10' });
});
export type UploadRequest = z.infer<typeof UploadRequest>;

/**
 * A rejection the server decided on. The full record is `sync_rejection`
 * (documents.ts), synced back down; this is the immediate acknowledgement so
 * the device can log it and move on. A rejected mutation is acknowledged, not
 * retried: retrying would only reproduce the same rejection and stall every
 * mutation queued behind it.
 */
export const UploadRejection = z.object({
  clientId: z.number().int().nonnegative(),
  table: DocType,
  id: z.string().min(1),
  category: RejectionCategory,
  reason: z.string().min(1),
  dependencies: z.array(FacilityDependency).min(1).optional(),
}).superRefine((record, context) => {
  if (record.category === 'dependency' && !record.dependencies?.length) context.addIssue({ code: 'custom', message: 'Dependency refusals must name the unaccepted references' });
});
export type UploadRejection = z.infer<typeof UploadRejection>;

export const UploadResponse = z.object({
  applied: z.number().int().nonnegative(),
  /** Mutations this device had already uploaded; applied once, acknowledged again. */
  duplicates: z.number().int().nonnegative(),
  rejected: z.array(UploadRejection),
  serverTime: isoDateTime,
  facilityContractVersion: z.literal(FACILITY_CONTRACT_VERSION).optional(),
}).superRefine((response, context) => {
  if (response.rejected.some((r) => r.category === 'dependency') && response.facilityContractVersion !== 1) context.addIssue({ code: 'custom', message: 'Dependency reconciliation requires the negotiated v1 connector' });
  const ids = response.rejected.map((item) => item.clientId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'A mutation cannot have duplicate or contradictory outcomes' });
});
export type UploadResponse = z.infer<typeof UploadResponse>;

/* ------------------------------------------------------------------ */
/* Health and time — GET /health · GET /time                           */
/* ------------------------------------------------------------------ */

export const SignedTime = z.object({
  now: isoDateTime,
  signature: z.string().min(1),
  publicKey: z.string().min(1),
});
export type SignedTime = z.infer<typeof SignedTime>;
