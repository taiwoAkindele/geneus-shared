/**
 * Geneus Health — shared contract: common building blocks.
 *
 * The envelope, enums, and helpers every document reuses. Nothing here is
 * Geneus-specific business logic — it is the shared vocabulary that keeps the
 * frontend (geneus-web), the backend (geneus-server), and CouchDB's
 * validate_doc_update guard from ever disagreeing about document shape.
 *
 * `zod` is provided by the CONSUMING repo (this is a plain submodule, not a
 * package), so both repos must have zod installed.
 */
import { z } from 'zod';

/** Bump when a breaking change is made to any document shape. Drives migration. */
export const SCHEMA_VERSION = 1 as const;

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

/** The `type` discriminator carried by every persisted document. */
export const DocType = z.enum([
  'patient',
  'visit',
  'handoff',
  'register_entry',
  'referral',
  'stock_item',
  'stock_movement',
  'facility',
  'unit',
  'staff',
  'roster_shift',
  'device_enrollment',
  'audit_event',
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
/* The document envelope                                               */
/* ------------------------------------------------------------------ */

/**
 * Every persisted CouchDB document extends this. CouchDB is one bag of JSON, so
 * `type` is how documents are told apart, and `facilityId` is how each
 * per-facility database keeps its data isolated (enforced again at the DB level
 * by validate_doc_update — see SCHEMA.md).
 *
 * `_id` / `_rev` are CouchDB-managed. `_rev` is absent until the first save.
 */
export const baseEnvelope = z.object({
  _id: z.string().min(1),
  _rev: z.string().optional(),

  /** Owning facility. For most docs this equals the DB it lives in. */
  facilityId: z.string().min(1),

  /** Shape version this document was written against. */
  schemaVersion: z.number().int().positive().default(SCHEMA_VERSION),

  /** Staff who created it (staffId) — 'system' for provisioning docs. */
  createdBy: z.string().min(1),
  createdOn: isoDateTime,

  /** Device the write originated on — used for conflict inspection (root §3). */
  deviceId: z.string().min(1),

  updatedBy: z.string().optional(),
  updatedOn: isoDateTime.optional(),
});
export type BaseEnvelope = z.infer<typeof baseEnvelope>;
