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
import { Facility, Staff, SyncOperation, RejectionCategory } from './documents.ts';

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

export const FacilityRegistration = z.object({
  code: facilityCode,
  name: z.string().min(1),
  state: z.string().min(1),
  lga: z.string().min(1),
  level: Facility.shape.level,
  adminFullName: z.string().min(1),
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
});
export type SyncTokenResponse = z.infer<typeof SyncTokenResponse>;

/** The claims geneus-server puts in the token; PowerSync reads `facility_id`. */
export const SyncTokenClaims = z.object({
  sub: z.string().min(1),
  aud: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  facility_id: z.string().min(1),
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
});
export type UploadMutation = z.infer<typeof UploadMutation>;

export const UploadRequest = z.object({
  /** PowerSync's local transaction id; null when the write was not transactional. */
  transactionId: z.number().int().nonnegative().nullable(),
  mutations: z.array(UploadMutation).min(1),
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
});
export type UploadRejection = z.infer<typeof UploadRejection>;

export const UploadResponse = z.object({
  applied: z.number().int().nonnegative(),
  /** Mutations this device had already uploaded; applied once, acknowledged again. */
  duplicates: z.number().int().nonnegative(),
  rejected: z.array(UploadRejection),
  serverTime: isoDateTime,
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
