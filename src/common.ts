/**
 * Geneus Health — shared contract: common building blocks.
 *
 * The envelope, enums, and helpers every record reuses. Nothing here is
 * Geneus-specific business logic — it is the shared vocabulary that keeps the
 * client (geneus-web, SQLite via PowerSync) and the server (geneus-server,
 * PostgreSQL) from ever disagreeing about record shape.
 *
 * `zod` is provided by the CONSUMING repo (this is a plain submodule, not a
 * package), so both repos must have zod installed.
 */
import { z } from 'zod';

/**
 * Bump when a breaking change is made to any record shape. Drives migration.
 * v2: registers became data-driven (`register_definition` + `register_entry`).
 * v3: PostgreSQL + PowerSync — `_id`/`_rev` replaced by `id`; `device_enrollment`
 *     became `device`; `sync_rejection` added; audit events carry an outcome;
 *     roster signatures are optional until the server signs them.
 */
export const SCHEMA_VERSION = 3 as const;

/* ------------------------------------------------------------------ */
/* Primitive helpers                                                   */
/* ------------------------------------------------------------------ */

/** ISO-8601 date-time with timezone offset, e.g. 2026-07-04T09:30:00+01:00 */
export const isoDateTime = z.string().datetime({ offset: true });

/** Calendar date only, YYYY-MM-DD (used for DOB, register entry dates). */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD');

/* ------------------------------------------------------------------ */
/* Shared enums                                                        */
/* ------------------------------------------------------------------ */

export const Sex = z.enum(['male', 'female']);
export type Sex = z.infer<typeof Sex>;

/** Where care was delivered — facility building vs off-site outreach (PRD §9.5). */
export const Setting = z.enum(['facility', 'outreach']);
export type Setting = z.infer<typeof Setting>;

/**
 * The `type` discriminator carried by every synced record. Each value is also
 * the name of the record's PostgreSQL table (pluralised) and its Sync Stream,
 * which is what lets the server keep one allowlist for uploads.
 */
export const DocType = z.enum([
  'patient',
  'visit',
  'handoff',
  'appointment',
  'register_definition',
  'register_entry',
  'referral',
  'stock_item',
  'stock_movement',
  'facility',
  'unit',
  'staff',
  'roster_shift',
  'device',
  'audit_event',
  'sync_rejection',
]);
export type DocType = z.infer<typeof DocType>;

/* ------------------------------------------------------------------ */
/* Patient ID (PRD §10.1)                                              */
/* ------------------------------------------------------------------ */

/**
 * Human-readable Patient ID: FACILITYCODE-SEQ-XX
 *   e.g. OOE-PHC-000047-K2
 *   - facility code = one or more UPPERCASE segments (OOE-PHC)
 *   - SEQ           = 6-digit zero-padded registration order (000047)
 *   - XX            = 2-char random safety code guaranteeing offline uniqueness
 *
 * Generation happens on the device, offline (see geneus-web). This regex is the
 * shared FORMAT contract — it validates, it does not generate.
 */
export const PATIENT_ID_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)+-\d{6}-[A-Z0-9]{2}$/;
export const patientId = z
  .string()
  .regex(PATIENT_ID_RE, 'Expected a Patient ID like OOE-PHC-000047-K2');

/* ------------------------------------------------------------------ */
/* The record envelope                                                 */
/* ------------------------------------------------------------------ */

/**
 * Every synced record extends this. `type` tells records apart in the client's
 * SQLite and in the upload stream; `facilityId` is the isolation boundary,
 * enforced by the server on every upload and by the facility-scoped Sync
 * Streams on every download (SCHEMA.md §2, §6).
 *
 * `id` is minted by whoever creates the record — the device, offline — and is
 * the primary key on both sides. PowerSync requires it to be text.
 */
export const baseEnvelope = z.object({
  id: z.string().min(1),

  /** Owning facility. Every record belongs to exactly one. */
  facilityId: z.string().min(1),

  /** Shape version this record was written against. */
  schemaVersion: z.number().int().positive().default(SCHEMA_VERSION),

  /** Staff who created it (staffId) — 'system' for server-written records. */
  createdBy: z.string().min(1),
  createdOn: isoDateTime,

  /** Device the write originated on — used for conflict inspection (root §3). */
  deviceId: z.string().min(1),

  updatedBy: z.string().optional(),
  updatedOn: isoDateTime.optional(),
});
export type BaseEnvelope = z.infer<typeof baseEnvelope>;

/**
 * The envelope fields a PATCH may never change. The server rejects an update
 * that touches any of them; the client never sends one (SCHEMA.md §6).
 */
export const IMMUTABLE_ENVELOPE_FIELDS = [
  'id',
  'facilityId',
  'createdBy',
  'createdOn',
  'deviceId',
] as const satisfies readonly (keyof BaseEnvelope)[];
