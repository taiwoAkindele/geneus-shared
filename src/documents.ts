/**
 * Geneus Health — shared contract: the document schemas.
 *
 * One Zod schema per record type. These are the single source of truth for
 * what a valid record looks like. geneus-web validates before writing to local
 * SQLite; geneus-server validates every uploaded mutation against the same
 * schema before it reaches PostgreSQL (see SCHEMA.md) — never hand-duplicated.
 */
import { z } from 'zod';
import {
  baseEnvelope,
  DocType,
  isoDate,
  isoDateTime,
  patientId,
  Sex,
  Setting,
} from './common.ts';

/* ================================================================== */
/* Patient (PRD §10 — NASADOR)                                         */
/* ================================================================== */

/** Convention: a patient record's `id` IS its patientId. */
export const Patient = baseEnvelope
  .extend({
    type: z.literal('patient'),
    patientId,
    // NASADOR
    fullName: z.string().min(1),
    address: z.string().min(1),
    sex: Sex,
    dateOfBirth: isoDate.optional(),
    /** True when DOB is a best-guess (elderly patient, no records — PRD §10). */
    dobEstimated: z.boolean().default(false),
    ageYears: z.number().int().nonnegative().max(130).optional(),
    occupation: z.string().optional(),
    religion: z.string().optional(),
    allergies: z.array(z.string()).default([]),
    // Strongest returning-patient signals (optional)
    phone: z.string().optional(),
    nin: z.string().optional(),
    /** Old paper folder / card number captured at first digital visit (PRD §10.2). */
    legacyPaperRef: z.string().optional(),
  })
  .refine((d) => Boolean(d.dateOfBirth) || d.ageYears != null, {
    message: 'Provide either dateOfBirth or ageYears',
    path: ['ageYears'],
  });
export type Patient = z.infer<typeof Patient>;

/* ================================================================== */
/* Encounters: Visit + Unit Handoff                                    */
/* ================================================================== */

/** A single guided visit note (PRD §9.1). Feeds registers + dashboards. */
export const Visit = baseEnvelope.extend({
  type: z.literal('visit'),
  patientId,
  unitId: z.string().min(1),
  visitDate: isoDateTime,
  setting: Setting.default('facility'),
  symptoms: z.array(z.string()).default([]),
  diagnosis: z.array(z.string()).default([]),
  treatment: z.string().optional(),
  /** Set when this visit produced a referral. */
  referralId: z.string().optional(),
  notes: z.string().optional(),
});
export type Visit = z.infer<typeof Visit>;

/** Instruction that travels with a patient between units (PRD §9.7). */
export const Handoff = baseEnvelope.extend({
  type: z.literal('handoff'),
  patientId,
  fromUnitId: z.string().min(1),
  toUnitId: z.string().min(1),
  instruction: z.string().min(1), // e.g. "Give tetanus toxoid injection"
  status: z.enum(['pending', 'received', 'done']).default('pending'),
});
export type Handoff = z.infer<typeof Handoff>;

/* ================================================================== */
/* Appointment (PRD §9.8)                                              */
/* ================================================================== */

export const AppointmentStatus = z.enum(['pending', 'scheduled']);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

export const Appointment = baseEnvelope
  .extend({
    type: z.literal('appointment'),
    patientId,
    reason: z.string().min(1),
    scheduledFor: isoDateTime.optional(),
    status: AppointmentStatus.default('pending'),
  })
  .refine((a) => a.status !== 'scheduled' || Boolean(a.scheduledFor), {
    message: 'A scheduled appointment needs scheduledFor',
    path: ['scheduledFor'],
  });
export type Appointment = z.infer<typeof Appointment>;

/* ================================================================== */
/* Registers (PRD §9.4) — data-driven, built per facility              */
/* ================================================================== */
/*
 * Registers are NOT hard-coded schemas. A facility configures each one at
 * runtime: a `register_definition` document holds its typed fields, and staff
 * record `register_entry` documents whose `values` are keyed by field id. This
 * is what lets a facility create a register with no code change and no DB
 * migration — creating one is just another document write.
 */

export const RegisterFieldType = z.enum([
  'text',
  'textarea',
  'number',
  'date',
  'phone',
  'select',
  'multiselect',
  'checkbox',
  'section',
]);
export type RegisterFieldType = z.infer<typeof RegisterFieldType>;

/** One field in a register. `id` is STABLE — entries key their values by it, so
 *  it must never be reused or reassigned (labels may change freely). */
export const RegisterFieldDef = z.object({
  id: z.string().min(1),
  type: RegisterFieldType,
  label: z.string().min(1),
  required: z.boolean().default(false),
  help: z.string().optional(),
  /** Choices for `select` / `multiselect`. */
  options: z.array(z.string()).optional(),
});
export type RegisterFieldDef = z.infer<typeof RegisterFieldDef>;

export const RegisterStatus = z.enum(['draft', 'published']);
export type RegisterStatus = z.infer<typeof RegisterStatus>;

/**
 * A facility-configured register. **Immutable per version:** publishing an edit
 * writes a NEW version document rather than mutating fields in place, so entries
 * pinned to an older `version` still render against the fields they were recorded
 * with — historical data never needs migrating.
 *
 * `id` convention: `${registerId}:v${version}` (a specific version). The
 * "current" register is the highest-version `published` record for a `registerId`.
 */
export const RegisterDefinition = baseEnvelope.extend({
  type: z.literal('register_definition'),
  registerId: z.string().min(1),
  version: z.number().int().positive().default(1),
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string().default(''),
  status: RegisterStatus.default('draft'),
  fields: z.array(RegisterFieldDef),
});
export type RegisterDefinition = z.infer<typeof RegisterDefinition>;

/** One field's recorded value — shape depends on the field's type. */
export const RegisterEntryValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
export type RegisterEntryValue = z.infer<typeof RegisterEntryValue>;

/**
 * An append-only entry recorded against a specific published register version.
 * `values` is keyed by `RegisterFieldDef.id`. The envelope and value *shapes* are
 * Zod-checked here, but per-field rules (required, correct type, valid option)
 * cannot be — no static schema knows a runtime register's fields. Enforce those
 * with {@link validateRegisterEntry} on the write path, in addition to
 * `parseDocument`.
 */
export const RegisterEntry = baseEnvelope.extend({
  type: z.literal('register_entry'),
  registerId: z.string().min(1),
  registerVersion: z.number().int().positive(),
  entryDate: isoDate,
  setting: Setting.default('facility'),
  /** Some entries link a stored patient; tally-style ones don't. */
  patientId: patientId.optional(),
  values: z.record(z.string(), RegisterEntryValue),
});
export type RegisterEntry = z.infer<typeof RegisterEntry>;

const matchesFieldType = (field: RegisterFieldDef, value: RegisterEntryValue | undefined): boolean => {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'date':
    case 'phone':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)));
    case 'checkbox':
      return typeof value === 'boolean';
    case 'select':
      return typeof value === 'string' && (!field.options || field.options.includes(value));
    case 'multiselect':
      return Array.isArray(value) && value.every((v) => !field.options || field.options.includes(v));
    default:
      return true;
  }
};

/**
 * Definition-driven validation for an entry's values against its register's
 * fields — the piece a static schema can't do. Enforces required fields and
 * per-field value types/options, so a new register needs no bespoke schema and
 * no migration. Returns human-readable issues (`[]` means valid).
 */
export const validateRegisterEntry = (
  fields: RegisterFieldDef[],
  values: Record<string, RegisterEntryValue | undefined>,
): string[] => {
  const issues: string[] = [];
  for (const field of fields) {
    if (field.type === 'section') continue;
    const value = values[field.id];
    const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (field.required) issues.push(`"${field.label}" is required`);
      continue;
    }
    if (!matchesFieldType(field, value)) issues.push(`"${field.label}" has an invalid value for a ${field.type} field`);
  }
  return issues;
};

/* ================================================================== */
/* Referral (PRD §11)                                                  */
/* ================================================================== */

export const ReferralStatus = z.enum(['sent', 'seen', 'arrived', 'closed']);
export type ReferralStatus = z.infer<typeof ReferralStatus>;

/** Honest delivery state (PRD §11.1). */
export const DeliveryStatus = z.enum(['alert_sent', 'alert_pending']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/** Tier-1: the only info that travels automatically with a referral (PRD §11.2). */
export const Tier1Payload = z.object({
  fullName: z.string().min(1),
  ageYears: z.number().int().nonnegative().optional(),
  dateOfBirth: isoDate.optional(),
  sex: Sex,
  allergies: z.array(z.string()).default([]),
  currentMedications: z.array(z.string()).default([]),
  reason: z.string().min(1),
});
export type Tier1Payload = z.infer<typeof Tier1Payload>;

export const Referral = baseEnvelope.extend({
  type: z.literal('referral'),
  /** `id` convention: equals referralId. */
  referralId: z.string().min(1),
  patientId,
  fromFacilityId: z.string().min(1), // usually === envelope.facilityId (the sender)
  toFacilityId: z.string().min(1),
  tier1: Tier1Payload,
  status: ReferralStatus.default('sent'),
  deliveryStatus: DeliveryStatus.default('alert_pending'),
  sentOn: isoDateTime,
  seenOn: isoDateTime.optional(),
  arrivedOn: isoDateTime.optional(),
  closedOn: isoDateTime.optional(),
  /** Set by the server watchdog when not Arrived within the window (PRD §11.3). */
  notYetArrivedFlagged: z.boolean().default(false),
});
export type Referral = z.infer<typeof Referral>;

/* ================================================================== */
/* Inventory (PRD §9.1, §9.6)                                          */
/* ================================================================== */

export const StockItem = baseEnvelope.extend({
  type: z.literal('stock_item'),
  name: z.string().min(1),
  category: z
    .enum(['drug', 'vaccine', 'test_kit', 'fp_commodity', 'consumable', 'other'])
    .default('other'),
  unitOfMeasure: z.string().optional(),
  quantityOnHand: z.number().nonnegative().default(0),
  reorderLevel: z.number().nonnegative().optional(),
});
export type StockItem = z.infer<typeof StockItem>;

export const StockMovement = baseEnvelope.extend({
  type: z.literal('stock_movement'),
  itemId: z.string().min(1),
  /** Positive = received, negative = dispensed/used. */
  change: z.number(),
  reason: z.enum(['received', 'dispensed', 'adjustment', 'expired', 'transfer']),
  movedOn: isoDateTime,
  note: z.string().optional(),
});
export type StockMovement = z.infer<typeof StockMovement>;

/* ================================================================== */
/* Organization: Facility, Unit, Staff, Roster, Enrollment, Audit      */
/* ================================================================== */

export const Facility = baseEnvelope.extend({
  type: z.literal('facility'),
  code: z.string().min(1), // e.g. OOE-PHC (PRD §10.1)
  name: z.string().min(1),
  lga: z.string().min(1),
  state: z.string().min(1),
  level: z
    .enum(['chc', 'phc', 'general_hospital', 'teaching_hospital', 'specialist'])
    .default('phc'),
});
export type Facility = z.infer<typeof Facility>;

/** Configurable per facility — no fixed list (PRD §9.7). */
export const Unit = baseEnvelope.extend({
  type: z.literal('unit'),
  unitId: z.string().min(1),
  name: z.string().min(1), // Registration, Consultation, Injection Room...
  active: z.boolean().default(true),
});
export type Unit = z.infer<typeof Unit>;

export const Role = z.enum([
  'chew',
  'nurse',
  'doctor',
  'records_officer',
  'facility_admin',
  'supervisor',
]);
export type Role = z.infer<typeof Role>;

/**
 * NOTE: no raw credentials/secrets live in the staff document. Offline-login
 * secrets and roster signatures are handled by geneus-server; the replica only
 * carries identity + role (PRD §14, root §4.3).
 */
/**
 * Whether this person may record care, or only look. Deliberately binary: the
 * role already carries what someone does, and a flag the app does not enforce
 * everywhere is worse than none.
 */
export const StaffPermission = z.enum(['read_only', 'read_write']);
export type StaffPermission = z.infer<typeof StaffPermission>;

export const Staff = baseEnvelope.extend({
  type: z.literal('staff'),
  staffId: z.string().min(1),
  fullName: z.string().min(1),
  role: Role,
  permission: StaffPermission.default('read_write'),
  active: z.boolean().default(true),
});
export type Staff = z.infer<typeof Staff>;

/**
 * One shift window (PRD §14.1). Written on the device; `signature` is added by
 * geneus-server once the shift syncs up, so the device can tell a tampered
 * roster from a genuine one while evaluating login OFFLINE (root §4.3). A shift
 * is unsigned until its first sync and grants access either way — the signature
 * is tamper-evidence, not an access gate (server PLAN §4.1).
 */
export const RosterShift = baseEnvelope.extend({
  type: z.literal('roster_shift'),
  staffId: z.string().min(1),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  /**
   * Detached server signature over (staffId, facilityId, startsAt, endsAt).
   * Server-owned: an upload that sets or changes it is rejected.
   */
  signature: z.string().min(1).optional(),
  /** Supervisor "extend for the day" override (PRD §14.1). */
  extendedUntil: isoDateTime.optional(),
});
export type RosterShift = z.infer<typeof RosterShift>;

export const DeviceStatus = z.enum(['active', 'revoked']);
export type DeviceStatus = z.infer<typeof DeviceStatus>;

/**
 * An enrolled device — the "where" of every write (root §4.3c). `id` is the
 * deviceId stamped on the envelope of everything that device writes. The
 * credential that lets it sync is held server-side as a hash and never appears
 * here; this record is what the facility can *see* about its devices.
 *
 * Server-written only: enrollment and revocation are online operations
 * (api.ts), so an upload to this table is rejected.
 */
export const Device = baseEnvelope.extend({
  type: z.literal('device'),
  /** Human label chosen at enrollment, e.g. "Front desk tablet". */
  label: z.string().optional(),
  enrolledBy: z.string().min(1),
  status: DeviceStatus.default('active'),
  /** Set on de-enroll → device drops its local replica on next contact. */
  wipeRequested: z.boolean().default(false),
  enrolledOn: isoDateTime,
  revokedOn: isoDateTime.optional(),
  /** Last time the server heard from it — what "recent server contact" means. */
  lastSeenOn: isoDateTime.optional(),
});
export type Device = z.infer<typeof Device>;

/** Append-only "who did what, when" trail (PRD §14). */
export const AuditAction = z.enum([
  'view',
  'create',
  'update',
  'login',
  'logout',
  'sync',
  'enroll',
  'revoke',
  'export',
  /** The server refused an uploaded mutation — see `sync_rejection`. */
  'reject',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditResult = z.enum(['ok', 'rejected']);
export type AuditResult = z.infer<typeof AuditResult>;

/**
 * Never updated or deleted, by anyone: PostgreSQL forbids it at the table level
 * and the server rejects a PATCH. `id` is minted on the device so a retried
 * upload cannot record the same event twice (root §12).
 *
 * `occurredOn` is the device's clock; `receivedOn` is the server's, set on
 * arrival and absent until then — security-sensitive ordering uses the latter.
 * `metadata` is for small facts about the action, never clinical content.
 */
export const AuditEvent = baseEnvelope.extend({
  type: z.literal('audit_event'),
  /** Staff the action is attributed to; absent for server-originated events. */
  actorStaffId: z.string().optional(),
  action: AuditAction,
  entityType: DocType.optional(),
  entityId: z.string().optional(),
  result: AuditResult.default('ok'),
  occurredOn: isoDateTime,
  receivedOn: isoDateTime.optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/* ================================================================== */
/* Sync rejection — the records officer's reconcile queue (root §4.1)  */
/* ================================================================== */

export const SyncOperation = z.enum(['put', 'patch', 'delete']);
export type SyncOperation = z.infer<typeof SyncOperation>;

/** Why the server would not apply a mutation. Drives the queue's grouping. */
export const RejectionCategory = z.enum([
  /** The device, facility or staff identity did not check out. */
  'identity',
  /** The attributed staff member may not perform this action. */
  'authorization',
  /** The payload failed the contract or an immutable field changed. */
  'validation',
  /** Another device changed the same thing first — a human must choose. */
  'conflict',
]);
export type RejectionCategory = z.infer<typeof RejectionCategory>;

/** One column two devices disagree on, with both values for a human to compare. */
export const ConflictingColumn = z.object({
  column: z.string().min(1),
  deviceValue: z.unknown(),
  serverValue: z.unknown(),
});
export type ConflictingColumn = z.infer<typeof ConflictingColumn>;

/**
 * Written by the server when an uploaded mutation cannot be applied, and
 * synced back down so the facility can see and resolve it. A rejected clinical
 * write is never discarded silently: this record is where it goes. Only
 * `resolvedOn` / `resolvedBy` / `resolution` may be set from the device, by a
 * staff member holding `sync_rejection:resolve`.
 */
export const SyncRejection = baseEnvelope.extend({
  type: z.literal('sync_rejection'),
  entityType: DocType,
  entityId: z.string().min(1),
  operation: SyncOperation,
  category: RejectionCategory,
  /** Human-readable, e.g. "staff:manage is not granted to role nurse". */
  reason: z.string().min(1),
  /** Staff the rejected mutation was attributed to (its createdBy/updatedBy). */
  attributedTo: z.string().optional(),
  /** Device's clock for the mutation; the envelope's createdOn is the server's. */
  occurredOn: isoDateTime.optional(),
  /** Present for `conflict` only — the columns to reconcile, nothing more. */
  conflicts: z.array(ConflictingColumn).optional(),
  resolvedOn: isoDateTime.optional(),
  resolvedBy: z.string().optional(),
  resolution: z.string().optional(),
});
export type SyncRejection = z.infer<typeof SyncRejection>;
