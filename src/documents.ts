import { Disposition, InvestigationItem, InvestigationReview } from './careWorkflow.ts';
/**
 * Geneus Health — shared contract: the document schemas.
 *
 * One Zod schema per record type. These are the single source of truth for
 * what a valid record looks like. geneus-web validates before writing to local
 * SQLite; geneus-server validates every uploaded mutation against the same
 * schema before it reaches PostgreSQL (see SCHEMA.md) — never hand-duplicated.
 */
import { z } from 'zod';
import { AppointmentAllocation, ClinicalActorContext, FacilityDependency, FacilityTimeZone, FacilityWorkforcePolicy, OrganizationKind, RESTRICTED_FACILITY_DOCUMENT_TYPES, distinctRefs, facilityIdRef } from './facilityTypes.ts';
import { AssignablePermission } from './capabilities.ts';
import { provisionalPatientName, validCalendarDate, yearsBetween } from './patientIdentity.ts';
import {
  baseEnvelope,
  DocType,
  isoDate,
  isoDateTime,
  patientId,
  receiptNumber,
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
    address: z.string().trim().min(1).nullish().transform((v) => v ?? undefined).optional(),
    sex: Sex.nullish().transform((v) => v ?? undefined).optional(),
    identityStatus: z.enum(['identified', 'provisional']).default('identified'),
    /** Original circumstances are retained after later identification. */
    provisionalReason: z.string().trim().min(3).max(500).nullish().transform((v) => v ?? undefined).optional(),
    identifiedBy: z.string().min(1).nullish().transform((v) => v ?? undefined).optional(),
    identifiedOn: isoDateTime.nullish().transform((v) => v ?? undefined).optional(),
    identificationNote: z.string().trim().min(3).max(500).nullish().transform((v) => v ?? undefined).optional(),
    /** Exact provisional demographics reviewed when completing identification. */
    identificationBase: z.strictObject({ fullName: z.string(), sex: Sex.nullable(), address: z.string().nullable(),
      dateOfBirth: isoDate.nullable(), ageYears: z.number().int().nullable(), ageObservedOn: isoDate.nullable(),
      phone: z.string().nullable(), nin: z.string().nullable(), legacyPaperRef: z.string().nullable(),
    }).nullish().transform((v) => v ?? undefined).optional(),
    dateOfBirth: isoDate.refine(validCalendarDate, 'Enter a valid calendar date').nullish().transform((v) => v ?? undefined).optional(),
    /** True when DOB is a best-guess (elderly patient, no records — PRD §10). */
    dobEstimated: z.boolean().default(false),
    ageYears: z.number().int().nonnegative().max(130).nullish().transform((v) => v ?? undefined).optional(),
    ageObservedOn: isoDate.refine(validCalendarDate).nullish().transform((v) => v ?? undefined).optional(),
    occupation: z.string().nullish().transform((v) => v ?? undefined).optional(),
    religion: z.string().nullish().transform((v) => v ?? undefined).optional(),
    allergies: z.array(z.string()).default([]),
    // Strongest returning-patient signals (optional)
    phone: z.string().nullish().transform((v) => v ?? undefined).optional(),
    nin: z.string().nullish().transform((v) => v ?? undefined).optional(),
    /** Evidence reported by staff, not an external identity-provider verification. */
    identityEvidence: z.enum(['reported', 'document_seen']).optional(),
    identityEvidenceNote: z.string().max(300).nullish().transform((v) => v ?? undefined).optional(),
    /** Old paper folder / card number captured at first digital visit (PRD §10.2). */
    legacyPaperRef: z.string().nullish().transform((v) => v ?? undefined).optional(),
  })
  .refine((d) => d.identityStatus === 'provisional' || Boolean(d.dateOfBirth) || d.ageYears != null, {
    message: 'Provide either dateOfBirth or ageYears',
    path: ['ageYears'],
  })
  .superRefine((d, ctx) => {
    if (d.identityStatus === 'identified') {
      if (!d.sex) ctx.addIssue({ code: 'custom', path: ['sex'], message: 'Record sex for an identified patient' });
      if (!d.address) ctx.addIssue({ code: 'custom', path: ['address'], message: 'Record an address for an identified patient' });
      if (d.provisionalReason && (!d.identifiedBy || !d.identifiedOn || !d.identificationNote || !d.identificationBase)) ctx.addIssue({ code: 'custom', path: ['identificationNote'], message: 'Later identification requires an attributed explanation and the reviewed provisional details' });
      if (!d.provisionalReason && (d.identifiedBy || d.identifiedOn || d.identificationNote || d.identificationBase)) ctx.addIssue({ code: 'custom', path: ['provisionalReason'], message: 'Identification history requires an original provisional registration' });
    } else {
      if (d.schemaVersion < 5) ctx.addIssue({ code: 'custom', path: ['schemaVersion'], message: 'Provisional registration requires schema 5' });
      if (!d.provisionalReason) ctx.addIssue({ code: 'custom', path: ['provisionalReason'], message: 'Explain why identity is not yet known' });
      if (d.fullName !== provisionalPatientName(d.patientId)) ctx.addIssue({ code: 'custom', path: ['fullName'], message: 'Use the distinct provisional patient label' });
      if (d.identifiedBy || d.identifiedOn || d.identificationNote || d.identificationBase) ctx.addIssue({ code: 'custom', path: ['identifiedOn'], message: 'An unidentified patient cannot have a completed identification' });
    }
    const observed = d.ageObservedOn ?? d.createdOn.slice(0, 10);
    if (d.dateOfBirth && d.dateOfBirth > observed) ctx.addIssue({ code: 'custom', path: ['dateOfBirth'], message: 'Date of birth cannot be after the age observation date' });
    if (d.dateOfBirth && yearsBetween(d.dateOfBirth, observed) > 130) ctx.addIssue({ code: 'custom', path: ['dateOfBirth'], message: 'Check the birth date; age exceeds 130 years' });
    if (d.dateOfBirth && d.ageYears !== undefined && d.ageObservedOn && yearsBetween(d.dateOfBirth, d.ageObservedOn) !== d.ageYears) ctx.addIssue({ code: 'custom', path: ['ageYears'], message: 'Age and date of birth do not agree' });
    if (d.identityEvidence === 'document_seen' && !d.identityEvidenceNote?.trim()) ctx.addIssue({ code: 'custom', path: ['identityEvidenceNote'], message: 'Describe the identity evidence checked' });
  });
export type Patient = z.infer<typeof Patient>;

/** Append-only review history; only the server may confirm a link or its removal. */
export const PatientIdentityEvent = baseEnvelope.extend({
  type: z.literal('patient_identity_event'),
  patientId,
  otherPatientId: patientId.optional(),
  outcome: z.enum(['existing_selected', 'registration_distinct', 'review_requested', 'linked', 'distinct', 'unlinked']),
  reason: z.string().trim().min(3).max(1000),
  revision: z.number().int().positive().optional(),
}).refine((d) => d.outcome === 'existing_selected' || Boolean(d.otherPatientId && d.otherPatientId !== d.patientId), { message: 'Choose two different patient records', path: ['otherPatientId'] });
export type PatientIdentityEvent = z.infer<typeof PatientIdentityEvent>;

/* ================================================================== */
/* Visit + Unit Handoff                                                */
/* ================================================================== */

/**
 * A single guided visit note (PRD §9.1). Superseded by the encounter (PRD §9.8,
 * `encounter` + `encounter_entry` below); kept so existing rows stay readable.
 */
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
  /** The encounter the patient is being moved within, when there is one. */
  encounterId: z.string().min(1).optional(),
  instruction: z.string().min(1), // e.g. "Give tetanus toxoid injection"
  status: z.enum(['pending', 'received', 'done']).default('pending'),
});
export type Handoff = z.infer<typeof Handoff>;

/* ================================================================== */
/* Appointment (PRD §9.8)                                              */
/* ================================================================== */

export const AppointmentStatus = z.enum(['pending', 'scheduled']);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

/** Booking mode above is retained for older records; attendance is recorded separately. */
export const AppointmentAttendance = z.enum(['booked', 'arrived', 'cancelled', 'no_show']);
export type AppointmentAttendance = z.infer<typeof AppointmentAttendance>;
export const AppointmentAction = z.enum(['arrived', 'cancelled', 'no_show', 'rescheduled', 'reopened']);
export type AppointmentAction = z.infer<typeof AppointmentAction>;
export const AppointmentActivity = z.object({
  id: z.string().min(1),
  action: AppointmentAction,
  recordedBy: z.string().min(1),
  recordedOn: isoDateTime,
  fromAttendance: AppointmentAttendance,
  toAttendance: AppointmentAttendance,
  fromScheduledFor: isoDateTime.optional(),
  toScheduledFor: isoDateTime.optional(),
  reason: z.string().trim().min(1).optional(),
}).strict();
export type AppointmentActivity = z.infer<typeof AppointmentActivity>;
export const sameAppointmentTime = (left?: string, right?: string): boolean => {
  if (!left || !right) return left === right;
  return Date.parse(left) === Date.parse(right);
};

/**
 * What the visit is for, chosen at booking. Exemption rules are written against
 * it (PRD §9.13.2) — an antenatal or immunisation visit is often free by policy
 * — so it is a fixed list both consumers and every facility's rules agree on.
 */
export const VisitType = z.enum([
  'general',
  'follow_up',
  'antenatal',
  'postnatal',
  'delivery',
  'immunisation',
  'family_planning',
  'child_welfare',
  'tb_programme',
  'hiv_programme',
  'emergency',
]);
export type VisitType = z.infer<typeof VisitType>;

export const Appointment = baseEnvelope
  .extend({
    type: z.literal('appointment'),
    patientId,
    reason: z.string().min(1),
    scheduledFor: isoDateTime.optional(),
    status: AppointmentStatus.default('pending'),
    attendance: AppointmentAttendance.optional(),
    /** Append one attributed action per change; existing history cannot be replaced. */
    activity: z.array(AppointmentActivity).optional(),
    /** Absent on bookings made before visit types existed. */
    visitType: VisitType.optional(),
    /** Includes first-visit charges raised at registration before this booking. */
    chargeIds: z.array(z.string().min(1)).optional(),
    /** Optional v4 resource proposal; a server reservation confirms it separately. */
    allocation: AppointmentAllocation.optional(),
  })
  .refine((a) => a.status !== 'scheduled' || Boolean(a.scheduledFor), {
    message: 'A scheduled appointment needs scheduledFor',
    path: ['scheduledFor'],
  })
  .superRefine((appointment, context) => {
    if (appointment.allocation && (!appointment.scheduledFor || Date.parse(appointment.allocation.endsAt) <= Date.parse(appointment.scheduledFor))) context.addIssue({ code: z.ZodIssueCode.custom, path: ['allocation'], message: 'A resource allocation needs a start and a later end' });
    const activity = appointment.activity ?? [];
    const ids = new Set<string>();
    for (let i = 0; i < activity.length; i++) {
      const event = activity[i], previous = activity[i - 1];
      const fail = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path: ['activity', i], message });
      if (ids.has(event.id)) fail('Each booking action needs a distinct identity');
      ids.add(event.id);
      if (previous && (event.fromAttendance !== previous.toAttendance || !sameAppointmentTime(event.fromScheduledFor, previous.toScheduledFor))) fail('Booking history must continue from the preceding action');
      if (!previous && event.fromAttendance !== 'booked') fail('Booking history must begin with a booked appointment');
      if (previous && Date.parse(event.recordedOn) < Date.parse(previous.recordedOn)) fail('Booking action dates cannot go backwards');
      if (Date.parse(event.recordedOn) < Date.parse(appointment.createdOn)) fail('Booking actions cannot predate the booking');
      if (event.action !== 'arrived' && !event.reason) fail('Explain this booking change');
      const expected = event.action === 'rescheduled' || event.action === 'reopened' ? 'booked' : event.action;
      if (event.toAttendance !== expected) fail('The action and attendance state disagree');
      if (event.action !== 'rescheduled' && !sameAppointmentTime(event.fromScheduledFor, event.toScheduledFor)) fail('Only rescheduling can change the booking time');
      if (event.action === 'rescheduled' && (!event.toScheduledFor || sameAppointmentTime(event.toScheduledFor, event.fromScheduledFor) || Date.parse(event.toScheduledFor) <= Date.parse(event.recordedOn))) fail('Choose a different future date and time');
      if (event.action === 'reopened' ? !['cancelled', 'no_show'].includes(event.fromAttendance) : ['cancelled', 'no_show'].includes(event.fromAttendance) && event.action !== 'rescheduled') fail('Reopen or reschedule this inactive booking first');
      if (event.action === event.fromAttendance) fail('This attendance state is already recorded');
      if (event.action === 'no_show' && (event.fromAttendance !== 'booked' || Date.parse(event.fromScheduledFor ?? appointment.createdOn) > Date.parse(event.recordedOn))) fail('Only a due booking without a recorded arrival can be marked no-show');
    }
    const last = activity[activity.length - 1];
    if (last && (last.toAttendance !== (appointment.attendance ?? 'booked') || !sameAppointmentTime(last.toScheduledFor, appointment.scheduledFor))) context.addIssue({ code: z.ZodIssueCode.custom, path: ['activity'], message: 'The booking must match its latest action' });
    if (!last && appointment.attendance && appointment.attendance !== 'booked') context.addIssue({ code: z.ZodIssueCode.custom, path: ['activity'], message: 'Attendance needs an attributed action' });
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
  sex: Sex.optional(),
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
export const InboundReferral = baseEnvelope.extend({
  type: z.literal('inbound_referral'), sourceReferralId: z.string().min(1), fromFacilityId: z.string().min(1), senderPatientId: patientId,
  tier1: Tier1Payload, sentOn: isoDateTime, status: z.enum(['received', 'arrived', 'closed']).default('received'),
  localPatientId: patientId.optional(), localEncounterId: z.string().min(1).optional(), arrivedOn: isoDateTime.optional(), closedOn: isoDateTime.optional(),
}).refine((v) => v.status === 'received' || Boolean(v.localPatientId && v.arrivedOn), 'Arrival requires a local patient and time')
  .refine((v) => v.status !== 'closed' || Boolean(v.closedOn), 'Closing requires a time');
export type InboundReferral = z.infer<typeof InboundReferral>;

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
  allowCustomInvestigations: z.boolean().optional(),
  type: z.literal('facility'),
  code: z.string().min(1), // e.g. OOE-PHC (PRD §10.1)
  name: z.string().min(1),
  lga: z.string().min(1),
  state: z.string().min(1),
  timeZone: FacilityTimeZone.optional(),
  /** Server-owned after readiness/mixed-client checks; never inferred from a legacy role. */
  workforcePolicy: FacilityWorkforcePolicy.optional(),
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
  /** Omitted on legacy units; resolve as a routable unit, never an inferred room. */
  kind: OrganizationKind.optional(),
  parentId: facilityIdRef.optional(),
  routingEnabled: z.boolean().optional(),
  revision: z.number().int().positive().optional(),
}).superRefine((unit, context) => {
  if (unit.parentId === unit.id || unit.parentId === unit.unitId) context.addIssue({ code: 'custom', path: ['parentId'], message: 'A unit cannot contain itself' });
  if (unit.kind === 'department' && unit.routingEnabled === true) context.addIssue({ code: 'custom', path: ['routingEnabled'], message: 'Route care to a service unit, not a department' });
});
export type Unit = z.infer<typeof Unit>;

export const Role = z.enum([
  'chew',
  'nurse',
  'doctor',
  'records_officer',
  'facility_admin',
  'supervisor',
  /** Takes patients' payments (PRD §9.13.4); records no care. */
  'cashier',
  /** Access duties only; neither role establishes a professional qualification. */
  'laboratory_staff',
  'pharmacy_staff',
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

/** Whether fresh PIN sign-in needs an active roster window. */
export const LoginAccess = z.enum(['shift', 'always']);
export type LoginAccess = z.infer<typeof LoginAccess>;

export const Staff = baseEnvelope.extend({
  personId: z.string().min(1).optional(),
  type: z.literal('staff'),
  staffId: z.string().min(1),
  fullName: z.string().trim().min(1),
  /** The role stamped on new clinical contributions. */
  role: Role,
  additionalRoles: z.array(Role).max(Role.options.length)
    .refine((roles) => new Set(roles).size === roles.length, 'Choose each role only once').optional(),
  additionalPermissions: z.array(AssignablePermission).max(AssignablePermission.options.length)
    .refine((permissions) => new Set(permissions).size === permissions.length, 'Choose each permission only once').optional(),
  permission: StaffPermission.default('read_write'),
  /** Omitted on older staff records: scheduled shift sign-in is the default. */
  loginAccess: LoginAccess.optional(),
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
   * Detached Ed25519 signature (base64) over {@link rosterSignaturePayload}.
   * Server-owned: an upload that sets or changes it is rejected, and a change
   * to any signed field clears it until the server signs the shift again.
   */
  signature: z.string().min(1).optional(),
  /** Supervisor "extend for the day" override (PRD §14.1). */
  extendedUntil: isoDateTime.optional(),
});
export type RosterShift = z.infer<typeof RosterShift>;

/** The fields a roster signature covers; changing any of them invalidates it. */
export const ROSTER_SIGNED_FIELDS = ['staffId', 'facilityId', 'startsAt', 'endsAt', 'extendedUntil'] as const;

/**
 * The exact bytes geneus-server signs and the device verifies, as JSON with a
 * fixed key order. Times are epoch milliseconds rather than the ISO text,
 * because PostgreSQL and PowerSync may hand the same instant to each side
 * formatted differently. `extendedUntil` is covered so a supervisor extension
 * cannot be forged on the device under an old signature.
 */
export const rosterSignaturePayload = (
  shift: Pick<RosterShift, (typeof ROSTER_SIGNED_FIELDS)[number]>,
): string =>
  JSON.stringify({
    staffId: shift.staffId,
    facilityId: shift.facilityId,
    startsAt: Date.parse(shift.startsAt),
    endsAt: Date.parse(shift.endsAt),
    extendedUntil: shift.extendedUntil ? Date.parse(shift.extendedUntil) : null,
  });

/**
 * A one-time code that lets a member of staff set their PIN on a facility
 * device without anyone else's PIN being typed there (root §4.3). An admin
 * asks geneus-server for it from any enrolled device; the server shows the
 * code once, stores only its PBKDF2 hash here, and the record syncs down so a
 * device can check the code offline. Issuing a new code for the same person
 * revokes their earlier ones.
 *
 * Server-written. The only change a device may make is marking it used, as the
 * staff member the code was issued for.
 */
export const PinSetupCode = baseEnvelope.extend({
  type: z.literal('pin_setup_code'),
  /** Who may use it. */
  staffId: z.string().min(1),
  /** PBKDF2-SHA-256 of the code, base64. */
  codeHash: z.string().min(1),
  codeSalt: z.string().min(1),
  codeIterations: z.number().int().positive(),
  expiresOn: isoDateTime,
  revokedOn: isoDateTime.optional(),
  usedOn: isoDateTime.optional(),
  /** The device the PIN was set on. */
  usedOnDevice: z.string().optional(),
});
export type PinSetupCode = z.infer<typeof PinSetupCode>;

/** The columns a device may set on a {@link PinSetupCode}: marking it used. */
export const PIN_SETUP_CODE_CLAIM_FIELDS = ['usedOn', 'usedOnDevice'] as const;

/**
 * The code as it is hashed: read aloud and typed on a phone, so case and
 * stray spaces must not matter. The hash is PBKDF2-SHA-256 of these UTF-8
 * bytes, with the record's base64 `codeSalt` decoded to bytes, its
 * `codeIterations`, and a 32-byte output.
 */
export const normalizePinSetupCode = (code: string): string => code.replace(/\s+/g, '').toUpperCase();

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
/* Encounter (PRD §9.8) — one episode of care, recorded step by step   */
/* ================================================================== */
/*
 * An encounter is a header plus append-only entries. Each station saves its own
 * step as a new `encounter_entry`; a saved entry is never changed (PRD §9.8.3),
 * so a correction is another entry that `amends` the original. Nothing about an
 * encounter is ever patched — it is closed by saving a closing step — which is
 * why two devices recording the same patient can never race on one column.
 */

/** Opened when the first step is saved (PRD §9.8.1, step 2). Insert-only. */
export const Encounter = baseEnvelope.extend({
  workflowVersion: z.literal(1).optional(),
  type: z.literal('encounter'),
  patientId,
  openedOn: isoDateTime,
  setting: Setting.default('facility'),
  /** The appointment this visit was booked as, when there was one (PRD §9.8.1, step 2). */
  appointmentId: z.string().min(1).optional(),
  /**
   * Why the patient was seen before their fees were paid — "See now — collect
   * later" (PRD §9.13.5). Saved with the encounter, so the decision stays
   * attributed to the clinician who opened it.
   */
  collectLaterReason: z.string().trim().min(1).optional(),
});
export type Encounter = z.infer<typeof Encounter>;

export const EncounterStep = z.enum([
  'vitals',
  'complaint',
  'lab_order',
  'investigation_review',
  'result_review',
  'prescription',
  'injection_order',
  'disposition',
  'lab_results',
  'diagnosis',
  'injection',
  'dispense',
  'admission',
  'follow_up',
  /** A correction to an earlier entry, linked through `amends` (PRD §9.8.3). */
  'amendment',
]);
export type EncounterStep = z.infer<typeof EncounterStep>;

/** Saving one of these steps closes the encounter: as an inpatient, or sent home. */
export const CLOSING_STEPS = ['admission', 'follow_up', 'disposition'] as const satisfies readonly EncounterStep[];
/** Reassessment is a new observation/note; other saved sections are corrected by amendment. */
export const REPEATABLE_STEPS = ['vitals', 'complaint', 'disposition', 'lab_results', 'result_review'] as const satisfies readonly EncounterStep[];

const positive = z.number().positive();
const text = z.string().trim().min(1);

export const PrescriptionLine = z.object({
  drug: text,
  dose: text,
  frequency: text.optional(),
  duration: text.optional(),
  route: text.optional(),
  quantity: z.number().positive().optional(),
});
export type PrescriptionLine = z.infer<typeof PrescriptionLine>;

export const InjectionRoute = z.enum(['IM', 'IV', 'SC', 'ID']);
export type InjectionRoute = z.infer<typeof InjectionRoute>;

/** What each step records. Strict, so a field meant for another step is refused. */
export const ENCOUNTER_STEP_VALUES = {
  vitals: z
    .strictObject({
      temperatureC: positive.optional(),
      systolicMmHg: positive.optional(),
      diastolicMmHg: positive.optional(),
      pulseBpm: positive.optional(),
      weightKg: positive.optional(),
      spo2Percent: positive.max(100).optional(),
      heightCm: positive.optional(),
      respiratoryRate: positive.optional(),
    })
    .refine((vitals) => Object.values(vitals).some((value) => value !== undefined), {
      message: 'Record at least one vital sign',
    }),
  complaint: z
    .strictObject({ complaints: z.array(text).default([]), note: text.optional(), historyOfPresentIllness: text.optional(), examination: text.optional(), assessment: text.optional(), plan: text.optional() })
    .refine((complaint) => complaint.complaints.length > 0 || Object.values(complaint).some((value) => typeof value === 'string' && value.length > 0), {
      message: 'Record a complaint or a clinical note',
    }),
  lab_order: z.strictObject({ tests: z.array(text).min(1), items: z.array(InvestigationItem).min(1).optional(), reason: text.optional() }).refine((v) => !v.items || (new Set(v.items.map((i) => i.id)).size === v.items.length && v.items.length === v.tests.length && v.items.every((i, n) => i.name === v.tests[n])), 'Order item identities must be unique and match the requested tests'),
  investigation_review: InvestigationReview,
  result_review: z.strictObject({ resultEntryIds: z.array(text).min(1).refine((ids) => new Set(ids).size === ids.length, 'Review each result entry once'), note: text.optional() }),
  prescription: z.strictObject({ decision: z.enum(['none_required', 'prescribed']), prescription: z.array(PrescriptionLine) }).refine((v) => v.decision === 'prescribed' ? v.prescription.length > 0 : v.prescription.length === 0, 'Record medications or explicitly select none required'),
  injection_order: z.strictObject({ required: z.boolean(), drug: text.optional(), dose: text.optional(), route: InjectionRoute.optional(), instructions: text.optional() }).refine((v) => !v.required || Boolean(v.drug && v.dose && v.route), 'An injection order needs drug, dose and route'),
  disposition: Disposition,
  lab_results: z.strictObject({ results: z.array(z.strictObject({ test: text, result: text, orderItemId: text.optional() })).min(1) }),
  diagnosis: z.strictObject({
    diagnosis: text,
    diagnoses: z.array(z.strictObject({ label: text, code: text.optional(), codingSystem: z.enum(['ICD-10', 'SNOMED CT', 'local']).optional(), certainty: z.enum(['unknown', 'suspected', 'confirmed']).default('unknown') }).refine((v) => !v.code || Boolean(v.codingSystem), 'Choose the coding system for this diagnosis code')).optional(),
    prescription: z.array(PrescriptionLine).default([]),
    giveInjection: z.boolean().default(false),
    admit: z.boolean().default(false),
    /** Why the clinician diagnosed before every ordered result was back and reviewed. */
    pendingResultsReason: text.max(500).optional(),
  }).refine((v) => !v.diagnoses?.length || v.diagnoses[0].label === v.diagnosis, 'The primary structured diagnosis must match the diagnosis'),
  injection: z.strictObject({
    drug: text,
    dose: text,
    route: InjectionRoute,
    site: text.optional(),
    note: text.optional(),
  }),
  dispense: z.strictObject({
    lines: z
      .array(
        z
          .strictObject({ drug: text, dispensed: z.boolean(), reason: text.optional() })
          .refine((line) => line.dispensed || Boolean(line.reason), {
            message: 'Give a reason for anything not dispensed',
            path: ['reason'],
          }),
      )
      .min(1),
  }),
  admission: z.strictObject({ ward: text, bed: text.optional(), note: text.optional() }),
  follow_up: z.strictObject({
    /** Absent when the patient is sent home with no review booked. */
    followUpOn: isoDate.refine(validCalendarDate, 'Enter a valid review date').optional(),
    reason: text.optional(),
    /** The appointment booked for the review (PRD §9.8.1, step 7). */
    appointmentId: z.string().min(1).optional(),
  }),
  amendment: z.strictObject({ note: text, correctedValues: z.record(z.string(), z.unknown()).optional(), previousAmendmentId: text.optional() }),
} as const satisfies Record<EncounterStep, z.ZodType>;
export type EncounterStepValues = { [Step in EncounterStep]: z.infer<(typeof ENCOUNTER_STEP_VALUES)[Step]> };

/**
 * One saved, locked step (PRD §9.8.4). The envelope's `createdBy` / `createdOn`
 * are the actor and the system time stamped at save (PRD §9.8.5); `actorRole`
 * records the role they held then, so the trail stays true if it later changes.
 * `values` is checked against the step's own schema in
 * {@link ENCOUNTER_STEP_VALUES}.
 */
export const EncounterEntry = baseEnvelope
  .extend({
    workflowVersion: z.literal(1).optional(),
    type: z.literal('encounter_entry'),
    encounterId: z.string().min(1),
    /** Repeated from the encounter so the patient's history is one lookup. */
    patientId,
    step: EncounterStep,
    actorRole: Role,
    actorContext: ClinicalActorContext.optional(),
    /** The entry this one corrects — set for an `amendment`, and only then. */
    amends: z.string().min(1).optional(),
    values: z.record(z.string(), z.unknown()),
  })
  .superRefine((entry, context) => {
    if ((entry.step === 'amendment') !== Boolean(entry.amends)) {
      context.addIssue({
        code: 'custom',
        path: ['amends'],
        message: 'An amendment must name the entry it amends, and only an amendment may',
      });
    }
    const values = ENCOUNTER_STEP_VALUES[entry.step].safeParse(entry.values);
    for (const issue of values.success ? [] : values.error.issues) {
      context.addIssue({ code: 'custom', path: ['values', ...issue.path], message: issue.message });
    }
  });
export type EncounterEntry = z.infer<typeof EncounterEntry>;

/* ================================================================== */
/* Billing (PRD §9.13) — fees, what a patient owes, what they paid     */
/* ================================================================== */
/*
 * Money is three records. The facility's price list (`fee_item`) is the only
 * one ever edited. What a patient owes (`charge`) and what was paid against it
 * (`payment`) are insert-only, like encounter entries: a mistake is cancelled by
 * a reversing payment, never edited away (PRD §9.13.6). Whether an appointment
 * is confirmed is never stored — it is worked out from its charges and the
 * payments against them, so the front desk and the cashier never race on one
 * column.
 *
 * Amounts are whole numbers in the currency's minor unit (kobo for NGN), so
 * every sum is exact. The ISO 4217 currency travels with every amount rather
 * than being assumed: a deployment's country is not the contract's business.
 */

/** An amount in the currency's minor unit, e.g. kobo. */
export const minorUnits = z.number().int().nonnegative();

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code like NGN');

export const FeeCategory = z.enum(['registration', 'card', 'consultation', 'laboratory', 'procedure', 'other']);
export type FeeCategory = z.infer<typeof FeeCategory>;

/**
 * When a fee is raised (PRD §9.13.1): once in a patient's life at the facility
 * (registration, card), at every booked visit (consultation), or when a
 * clinician orders the service it pays for.
 */
export const ChargeWhen = z.enum(['first_visit', 'every_visit', 'when_ordered']);
export type ChargeWhen = z.infer<typeof ChargeWhen>;

/**
 * One condition under which a fee is not charged (PRD §9.13.2), e.g.
 * `{ reason: 'Under-5 policy', ageUnderYears: 5 }`. Every condition a rule
 * gives must hold; a fee is exempt when any one of its rules matches.
 */
export const ExemptionRule = z
  .strictObject({
    /** Shown on the bill and in the reports: "Exempt — Under-5 policy". */
    reason: text,
    /** Matches a patient younger than this many whole years. */
    ageUnderYears: z.number().int().positive().max(130).optional(),
    /** Matches a patient this many whole years old or older. */
    ageFromYears: z.number().int().nonnegative().max(130).optional(),
    sex: Sex.optional(),
    visitTypes: z.array(VisitType).min(1).optional(),
  })
  .refine(
    (rule) =>
      rule.ageUnderYears !== undefined ||
      rule.ageFromYears !== undefined ||
      rule.sex !== undefined ||
      rule.visitTypes !== undefined,
    { message: 'An exemption needs at least one condition' },
  )
  .refine(
    (rule) => rule.ageUnderYears === undefined || rule.ageFromYears === undefined || rule.ageFromYears < rule.ageUnderYears,
    { message: 'No patient can be both that old and that young', path: ['ageFromYears'] },
  );
export type ExemptionRule = z.infer<typeof ExemptionRule>;

/** What exemption rules are checked against, known when the fee is raised. */
export type ExemptionFacts = {
  /** Whole years at the time of the visit; absent when it cannot be worked out. */
  ageYears?: number;
  sex?: Sex;
  visitType?: VisitType;
};

const matchesExemption = (rule: ExemptionRule, facts: ExemptionFacts): boolean => {
  // A rule never matches on a fact nobody recorded — a missing age is not "under 5".
  if (rule.ageUnderYears !== undefined && (facts.ageYears === undefined || facts.ageYears >= rule.ageUnderYears)) return false;
  if (rule.ageFromYears !== undefined && (facts.ageYears === undefined || facts.ageYears < rule.ageFromYears)) return false;
  if (rule.sex !== undefined && facts.sex !== rule.sex) return false;
  if (rule.visitTypes !== undefined && (facts.visitType === undefined || !rule.visitTypes.includes(facts.visitType))) return false;
  return true;
};

/**
 * The rule that makes a fee free for this patient and visit, if any. Shared, so
 * the device that raises the charge and anything that later checks it apply
 * the facility's policy identically.
 */
export const findExemption = (rules: readonly ExemptionRule[], facts: ExemptionFacts): ExemptionRule | undefined =>
  rules.find((rule) => matchesExemption(rule, facts));

/** One entry in the facility's fee schedule. Edited in place; charges keep the price they were raised at. */
export const FeeItem = baseEnvelope.extend({
  priceVersion: z.string().min(1).optional(),
  type: z.literal('fee_item'),
  name: text,
  category: FeeCategory,
  departmentId: z.string().min(1).nullable().optional(),
  amountMinor: minorUnits,
  currency: currencyCode,
  chargeWhen: ChargeWhen,
  exemptions: z.array(ExemptionRule).default([]),
  /** Retired fees are kept so old charges still name them; they are never raised again. */
  active: z.boolean().default(true),
});
export type FeeItem = z.infer<typeof FeeItem>;

/**
 * One fee raised against a patient (PRD §9.13.3). Insert-only. The fee's name,
 * category and price are copied in when it is raised, so a later price change
 * never alters a bill. An exempt charge is still written — at nothing owed,
 * with the rule's reason — so the reports can show the free care given.
 */
export const Charge = baseEnvelope
  .extend({
    orderItemId: z.string().min(1).optional(),
    orderEntryId: z.string().min(1).optional(),
    type: z.literal('charge'),
    patientId,
    feeItemId: z.string().min(1),
    description: text,
    category: FeeCategory,
    departmentId: z.string().min(1).optional(),
    /** The fee's price when this charge was raised. */
    listPriceMinor: minorUnits,
    /** What the patient owes: the list price, or nothing when exempt. */
    amountMinor: minorUnits,
    currency: currencyCode,
    exemptionReason: text.optional(),
    /** The booking that raised it; confirmed once every charge naming it is settled. */
    appointmentId: z.string().min(1).optional(),
    /** The encounter it belongs to, for fees raised by an order. */
    encounterId: z.string().min(1).optional(),
  })
  .refine((charge) => charge.amountMinor === (charge.exemptionReason ? 0 : charge.listPriceMinor), {
    message: 'A charge owes its full price, or nothing when an exemption applies',
    path: ['amountMinor'],
  });
export type Charge = z.infer<typeof Charge>;

/**
 * Cash, transfer and POS are money received. A waiver is a supervisor
 * cancelling what is owed by hand, for a patient no exemption rule covers
 * (PRD §9.13.2); it is a payment so that it settles charges the same way and
 * appears in the same reports.
 */
export const PaymentMethod = z.enum(['cash', 'transfer', 'pos', 'waiver']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

/** How much of a payment went to one charge. */
export const PaymentAllocation = z.strictObject({
  chargeId: z.string().min(1),
  amountMinor: minorUnits.positive(),
});
export type PaymentAllocation = z.infer<typeof PaymentAllocation>;

/**
 * Money received, or waived, against a patient's charges, with its receipt
 * (PRD §9.13.4). Insert-only. `createdBy` / `createdOn` are the cashier and the
 * time it was taken. A payment that `reverses` another cancels it — refunded,
 * or recorded in error (PRD §9.13.6) — and repeats the original's allocations,
 * which it takes back; the original stays visible.
 *
 * Checks that span records — that each charge is this patient's, in the same
 * currency, and not paid twice over — belong to the write path, not the shape.
 */
export const Payment = baseEnvelope
  .extend({
    type: z.literal('payment'),
    patientId,
    receiptNumber,
    method: PaymentMethod,
    /** Set only for allocations of a server-verified incoming bank transfer. */
    incomingTransferId: z.string().min(1).optional(),
    amountMinor: minorUnits.positive(),
    currency: currencyCode,
    allocations: z.array(PaymentAllocation).min(1),
    /** The bank transfer or POS reference, when there is one. */
    reference: text.optional(),
    /** Required for a waiver or a reversal: why. */
    reason: text.optional(),
    /** The payment this one cancels. */
    reverses: z.string().min(1).optional(),
  })
  .superRefine((payment, context) => {
    const allocated = payment.allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
    if (allocated !== payment.amountMinor) {
      context.addIssue({
        code: 'custom',
        path: ['allocations'],
        message: 'A payment must be allocated to charges in full, no more and no less',
      });
    }
    const chargeIds = payment.allocations.map((allocation) => allocation.chargeId);
    if (new Set(chargeIds).size !== chargeIds.length) {
      context.addIssue({ code: 'custom', path: ['allocations'], message: 'Allocate to each charge once' });
    }
    if ((payment.method === 'waiver' || payment.reverses) && !payment.reason) {
      context.addIssue({ code: 'custom', path: ['reason'], message: 'Give a reason for a waiver or a reversal' });
    }
  });
export type Payment = z.infer<typeof Payment>;

/** Append-only reduction: original price and approval remain visible. */
export const BillingAdjustment = baseEnvelope.extend({
  type: z.literal('billing_adjustment'), patientId,
  chargeId: z.string().min(1), kind: z.enum(['discount', 'waiver']),
  amountMinor: minorUnits.positive(), reason: text,
});
export type BillingAdjustment = z.infer<typeof BillingAdjustment>;

/** Verified provider receipt. Allocations live in payments. */
export const IncomingTransfer = baseEnvelope.extend({
  type: z.literal('incoming_transfer'), provider: z.literal('paystack'),
  mode: z.enum(['test', 'live']),
  providerReference: z.string().min(1), amountMinor: minorUnits.positive(),
  currency: currencyCode, receivedOn: isoDateTime, payerName: text.optional(),
  receivingAccount: text.optional(), departmentId: z.string().min(1).optional(),
});
export type IncomingTransfer = z.infer<typeof IncomingTransfer>;

/** Receiving-account ownership and reporting group; independent of fee category. */
export const BillingDepartment = baseEnvelope.extend({
  type: z.literal('billing_department'), name: text, active: z.boolean().default(true),
  /** Preserve the financial id while linking the canonical accountable organization. */
  organizationUnitId: facilityIdRef.optional(),
  revision: z.number().int().positive().optional(),
});
export type BillingDepartment = z.infer<typeof BillingDepartment>;

/* ================================================================== */
/* Sync rejection — the records officer's reconcile queue (root §4.1)  */
/* ================================================================== */

export const SyncOperation = z.enum(['put', 'patch', 'delete']);
export type SyncOperation = z.infer<typeof SyncOperation>;

/** Why the server would not apply a mutation. Drives the queue's grouping. */
export const RejectionCategory = z.enum([
  /** Referenced configuration has not been accepted; retain a linked reconciliation item. */
  'dependency',
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
 * synced back down so the facility can see and resolve it. No refused write is
 * lost: a refused insert keeps `refusedRecord`, a refused change keeps
 * `refusedChanges`, and it stays in the queue until a person applies it again
 * or discards it — which `resolvedBy` / `resolution` record in their name. Only
 * `resolvedOn` / `resolvedBy` / `resolution` may be set from the device, by a
 * staff member holding `sync_rejection:resolve`.
 */
export const SyncRejection = baseEnvelope.extend({
  type: z.literal('sync_rejection'),
  entityType: DocType,
  entityId: z.string().min(1),
  operation: SyncOperation,
  category: RejectionCategory,
  dependencies: z.array(FacilityDependency).min(1).optional(),
  /** Evidence refusals must not leak their payload through the general reconcile stream. Server-owned. */
  visibility: z.enum(['facility', 'restricted']).optional(),
  visibleToStaffIds: distinctRefs.optional(),
  /** Human-readable, e.g. "staff:manage is not granted to role nurse". */
  reason: z.string().min(1),
  /** Staff the rejected mutation was attributed to (its createdBy/updatedBy). */
  attributedTo: z.string().optional(),
  /** Device's clock for the mutation; the envelope's createdOn is the server's. */
  occurredOn: isoDateTime.optional(),
  /** Present for `conflict` only — the columns to reconcile, nothing more. */
  conflicts: z.array(ConflictingColumn).optional(),
  /**
   * The whole record as the device sent it, for a refused `put`. Without it a
   * refused insert would leave nothing to recover from — e.g. a patient whose
   * offline-minted ID another device took first (PRD §10.1).
   */
  refusedRecord: z.record(z.string(), z.unknown()).optional(),
  /**
   * The fields a wholly refused `patch` tried to set, and their values — e.g. a
   * phone number corrected by someone deactivated while the device was
   * offline. A patch refused only in part keeps its clash in `conflicts`.
   */
  refusedChanges: z.record(z.string(), z.unknown()).optional(),
  resolvedOn: isoDateTime.optional(),
  resolvedBy: z.string().optional(),
  resolution: z.string().optional(),
}).superRefine((record, context) => {
  if ((RESTRICTED_FACILITY_DOCUMENT_TYPES.some((type) => type === record.entityType) || record.visibility === 'restricted')
    && (record.visibility !== 'restricted' || !record.visibleToStaffIds?.length)) context.addIssue({ code: 'custom', message: 'Restricted refusals require an explicit restricted delivery audience' });
  if (record.category === 'dependency' && (!record.dependencies?.length || !(record.refusedRecord || record.refusedChanges))) context.addIssue({ code: 'custom', message: 'A dependency refusal must retain its references and original submitted payload' });
});
export type SyncRejection = z.infer<typeof SyncRejection>;
