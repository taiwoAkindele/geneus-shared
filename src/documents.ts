/**
 * Geneus Health — shared contract: the document schemas.
 *
 * One Zod schema per document type. These are the single source of truth for
 * what a valid document looks like. geneus-web validates before writing to local
 * PouchDB; geneus-server validates API payloads and reads; CouchDB's
 * validate_doc_update guard is GENERATED from these (see SCHEMA.md) — never
 * hand-duplicated.
 */
import { z } from 'zod';
import {
  baseEnvelope,
  isoDate,
  isoDateTime,
  patientId,
  Sex,
  Setting,
} from './common';

/* ================================================================== */
/* Patient (PRD §10 — NASADOR)                                         */
/* ================================================================== */

/** Convention: a patient document's `_id` IS its patientId. */
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
/* Programme registers (PRD §9.4)                                      */
/* Discriminated on `register`; all share type 'register_entry'.       */
/* ================================================================== */

const registerBase = baseEnvelope.extend({
  type: z.literal('register_entry'),
  /** Optional: some tally-style entries are not tied to a stored patient. */
  patientId: patientId.optional(),
  entryDate: isoDate,
  setting: Setting.default('facility'),
  ageYears: z.number().int().nonnegative().optional(),
  sex: Sex.optional(),
});

export const OpdEntry = registerBase.extend({
  register: z.literal('opd'),
  diagnosis: z.array(z.string()).default([]),
  referred: z.boolean().default(false),
});

export const Antigen = z.enum([
  'BCG',
  'OPV',
  'Penta',
  'PCV',
  'Rotavirus',
  'Measles',
  'YellowFever',
  'HepB',
  'TT', // tetanus toxoid
  'Vitamin_A',
]);
export const ImmunisationEntry = registerBase.extend({
  register: z.literal('immunisation'),
  antigen: Antigen,
  doseNumber: z.number().int().min(0),
  childAgeMonths: z.number().int().nonnegative().optional(),
});

export const FpMethod = z.enum([
  'implant',
  'injectable',
  'pills',
  'iud',
  'condom',
  'sterilisation',
  'other',
]);
export const FamilyPlanningEntry = registerBase.extend({
  register: z.literal('family_planning'),
  method: FpMethod,
  clientType: z.enum(['new', 'returning']),
  followUpDue: isoDate.optional(),
});

export const AntenatalEntry = registerBase.extend({
  register: z.literal('antenatal'),
  visitNumber: z.number().int().min(1),
  gestationalWeeks: z.number().int().min(0).max(45).optional(),
  testsDone: z.array(z.string()).default([]), // e.g. HIV, haemoglobin
  referred: z.boolean().default(false),
});

export const TbEntry = registerBase.extend({
  register: z.literal('tb'),
  presumptive: z.boolean().default(true),
  testType: z.enum(['sputum_smear', 'genexpert', 'none']).default('none'),
  result: z
    .enum(['positive', 'negative', 'pending', 'not_done'])
    .default('not_done'),
  startedTreatment: z.boolean().default(false),
});

export const MalariaEntry = registerBase.extend({
  register: z.literal('malaria'),
  testType: z.enum(['rdt', 'microscopy', 'none']).default('rdt'),
  result: z.enum(['positive', 'negative', 'not_done']).default('not_done'),
  treated: z.boolean().default(false),
  antimalarial: z.string().optional(),
});

export const RegisterEntry = z.discriminatedUnion('register', [
  OpdEntry,
  ImmunisationEntry,
  FamilyPlanningEntry,
  AntenatalEntry,
  TbEntry,
  MalariaEntry,
]);
export type RegisterEntry = z.infer<typeof RegisterEntry>;

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
  /** `_id` convention: equals referralId. */
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
export const Staff = baseEnvelope.extend({
  type: z.literal('staff'),
  staffId: z.string().min(1),
  fullName: z.string().min(1),
  role: Role,
  active: z.boolean().default(true),
});
export type Staff = z.infer<typeof Staff>;

/**
 * One signed shift window (PRD §14.1). `signature` is produced by geneus-server
 * so the device can trust the roster while evaluating login OFFLINE (root §4.3).
 */
export const RosterShift = baseEnvelope.extend({
  type: z.literal('roster_shift'),
  staffId: z.string().min(1),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  /** Detached server signature over (staffId, facilityId, startsAt, endsAt). */
  signature: z.string().min(1),
  /** Supervisor "extend for the day" override (PRD §14.1). */
  extendedUntil: isoDateTime.optional(),
});
export type RosterShift = z.infer<typeof RosterShift>;

/** Device enrollment gates the durable offline replica (root §4.3c). */
export const DeviceEnrollment = baseEnvelope.extend({
  type: z.literal('device_enrollment'),
  enrolledDeviceId: z.string().min(1),
  enrolledBy: z.string().min(1),
  status: z.enum(['active', 'revoked']).default('active'),
  /** Set on de-enroll → device drops its local replica on next contact. */
  wipeRequested: z.boolean().default(false),
  enrolledOn: isoDateTime,
  revokedOn: isoDateTime.optional(),
});
export type DeviceEnrollment = z.infer<typeof DeviceEnrollment>;

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
]);
export const AuditEvent = baseEnvelope.extend({
  type: z.literal('audit_event'),
  actorStaffId: z.string().optional(),
  action: AuditAction,
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  occurredOn: isoDateTime,
});
export type AuditEvent = z.infer<typeof AuditEvent>;
