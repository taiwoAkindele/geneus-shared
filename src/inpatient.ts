import { z } from 'zod';
import { baseEnvelope } from './common.ts';
import { Role, type Encounter, type EncounterEntry, type Unit } from './documents.ts';
import type { Location } from './facility.ts';
import { linkedPatientIds } from './patientIdentity.ts';
import type { PatientIdentityEvent } from './documents.ts';

const ref = z.string().trim().min(1);
export const InpatientAction = z.enum(['confirm', 'reserve', 'arrive', 'transfer', 'ready_for_discharge', 'continue_care', 'discharge', 'cancel']);
export type InpatientAction = z.infer<typeof InpatientAction>;
/** One immutable operational change. The source consultation is never reopened or overwritten. */
export const InpatientEvent = baseEnvelope.extend({
  type: z.literal('inpatient_event'), admissionId: ref, patientId: ref, encounterId: ref,
  requestEntryId: ref, previousId: ref.optional(), action: InpatientAction,
  receivingUnitId: ref, wardId: ref.optional(), bedId: ref.optional(), actorRole: Role,
  note: z.string().trim().min(1).max(4000).optional(),
}).superRefine((event, ctx) => {
  if ((event.action === 'confirm') !== !event.previousId || event.previousId === event.id)
    ctx.addIssue({ code: 'custom', message: 'Confirmation starts a new admission; later actions name its previous event' });
  if (event.action === 'confirm' && (event.admissionId !== event.id || event.wardId || event.bedId))
    ctx.addIssue({ code: 'custom', message: 'A confirmed admission starts awaiting a bed' });
  if (Boolean(event.wardId) !== Boolean(event.bedId)) ctx.addIssue({ code: 'custom', message: 'Ward and bed must be recorded together' });
  if (['reserve', 'arrive', 'transfer', 'ready_for_discharge', 'continue_care', 'discharge'].includes(event.action) && !event.bedId)
    ctx.addIssue({ code: 'custom', message: 'This action requires a ward and bed' });
  if (['transfer', 'cancel', 'continue_care'].includes(event.action) && !event.note)
    ctx.addIssue({ code: 'custom', message: 'Record the reason for this change', path: ['note'] });
});
export type InpatientEvent = z.infer<typeof InpatientEvent>;
/** Cleaning releases a particular departure/transfer, never a generic free/occupied toggle. */
export const BedReadyEvent = baseEnvelope.extend({
  type: z.literal('bed_ready_event'), bedId: ref, releaseEventId: ref, actorRole: Role,
  note: z.string().trim().min(1).max(4000).optional(),
});
export type BedReadyEvent = z.infer<typeof BedReadyEvent>;

export const INPATIENT_STATUS = {
  confirm: 'Awaiting bed', reserve: 'Awaiting arrival', arrive: 'In ward', transfer: 'In ward',
  ready_for_discharge: 'Ready for discharge', continue_care: 'In ward', discharge: 'Discharged', cancel: 'Cancelled',
} as const;
export const activeAdmission = (event: InpatientEvent) => !['discharge', 'cancel'].includes(event.action);
export const inpatientHeads = (events: readonly InpatientEvent[]): InpatientEvent[] => {
  const replaced = new Set(events.map((event) => event.previousId));
  return events.filter((event) => !replaced.has(event.id));
};
export const admissionRequest = (entry: EncounterEntry) => entry.step === 'admission' || (entry.step === 'disposition' && entry.values.kind === 'admission');

export const wardForBed = (bed: Location, locations: readonly Location[]): Location | undefined => {
  const seen = new Set([bed.id]); let parentId = bed.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = locations.find((location) => location.id === parentId && location.facilityId === bed.facilityId);
    if (!parent || !parent.active) return undefined;
    if (parent.kind === 'ward') return parent;
    parentId = parent.parentId;
  }
  return undefined;
};
export const releasedBed = (event: InpatientEvent, events: readonly InpatientEvent[]): string | undefined => {
  if (!['transfer', 'discharge'].includes(event.action)) return undefined;
  return events.find((previous) => previous.id === event.previousId)?.bedId;
};
export type BedState = { status: 'Available' | 'Reserved' | 'Occupied' | 'Cleaning' | 'Conflict'; admission?: InpatientEvent; release?: InpatientEvent };
/** Project all beds in one pass; do not scan a growing stay history separately for each bed. */
export const inpatientBedStates = (events: readonly InpatientEvent[], ready: readonly BedReadyEvent[]): Map<string, BedState> => {
  const states = new Map<string, BedState>(), byId = new Map(events.map((event) => [event.id, event]));
  const cleaned = new Map<string, Set<string>>();
  for (const event of ready) { const beds = cleaned.get(event.releaseEventId) ?? new Set<string>(); beds.add(event.bedId); cleaned.set(event.releaseEventId, beds); }
  for (const event of events) {
    if (!['transfer','discharge'].includes(event.action)) continue;
    const bedId = event.previousId ? byId.get(event.previousId)?.bedId : undefined;
    if (bedId && !cleaned.get(event.id)?.has(bedId)) states.set(bedId, { status: 'Cleaning', release: event });
  }
  for (const event of inpatientHeads(events)) {
    if (!activeAdmission(event) || !event.bedId) continue;
    states.set(event.bedId, states.has(event.bedId) ? { status: 'Conflict' } : { status: event.action === 'reserve' ? 'Reserved' : 'Occupied', admission: event });
  }
  return states;
};
export const inpatientBedState = (bedId: string, events: readonly InpatientEvent[], ready: readonly BedReadyEvent[]): BedState => inpatientBedStates(events, ready).get(bedId) ?? { status: 'Available' };
export type InpatientRecords = {
  events: readonly InpatientEvent[]; ready: readonly BedReadyEvent[]; locations: readonly Location[];
  units: readonly Unit[]; encounters: readonly Encounter[]; entries: readonly EncounterEntry[];
  identities?: readonly PatientIdentityEvent[];
};

/** The same state checks run before local writes and against locked, accepted server records. */
export const inpatientIssues = (event: InpatientEvent, records: InpatientRecords): string[] => {
  const { events, locations, units, encounters, entries, ready } = records;
  const previous = events.find((item) => item.id === event.previousId);
  const heads = inpatientHeads(events);
  const encounter = encounters.find((item) => item.id === event.encounterId && item.facilityId === event.facilityId && item.patientId === event.patientId);
  if (!encounter) return ['The visit must belong to this patient and hospital'];
  const request = entries.find((item) => item.id === event.requestEntryId && item.encounterId === event.encounterId && item.patientId === event.patientId && item.facilityId === event.facilityId);
  if (!request || !admissionRequest(request)) return ['Choose a signed admission request from this visit'];
  if (event.action === 'confirm') {
    if (events.some((item) => item.requestEntryId === event.requestEntryId)) return ['This admission request has already been handled'];
    const patientIds = new Set(linkedPatientIds(event.patientId, records.identities ?? []));
    if (heads.some((item) => patientIds.has(item.patientId) && activeAdmission(item))) return ['This patient already has an active admission'];
  } else {
    if (!previous || !heads.some((item) => item.id === previous.id)) return ['This admission changed. Review its latest state before saving'];
    if (['admissionId', 'patientId', 'encounterId', 'requestEntryId', 'facilityId'].some((key) => event[key as keyof InpatientEvent] !== previous[key as keyof InpatientEvent])) return ['An admission cannot move to a different patient, visit or request'];
    const allowed: Record<InpatientAction, readonly InpatientAction[]> = {
      confirm: [], reserve: ['confirm', 'reserve'], arrive: ['reserve'], transfer: ['arrive', 'transfer', 'continue_care'],
      ready_for_discharge: ['arrive', 'transfer', 'continue_care'], continue_care: ['ready_for_discharge'],
      discharge: ['ready_for_discharge'], cancel: ['confirm', 'reserve'],
    };
    if (!allowed[event.action].includes(previous.action)) return ['This action is not available at the current admission stage'];
    if (!['reserve', 'transfer'].includes(event.action) && ['wardId', 'bedId', 'receivingUnitId'].some((key) => event[key as keyof InpatientEvent] !== previous[key as keyof InpatientEvent])) return ['Keep the recorded team and bed for this action'];
    if (event.action === 'transfer' && event.bedId === previous.bedId) return ['Choose a different bed for the transfer'];
  }
  if (['confirm', 'reserve', 'transfer'].includes(event.action)) {
    if (!units.some((unit) => unit.id === event.receivingUnitId && unit.facilityId === event.facilityId && unit.active && (unit.kind ?? 'unit') === 'unit')) return ['Choose an active receiving team in this hospital'];
  }
  if (['reserve', 'transfer'].includes(event.action)) {
    const bed = locations.find((location) => location.id === event.bedId && location.facilityId === event.facilityId && location.kind === 'bed' && location.active);
    if (!bed || wardForBed(bed, locations)?.id !== event.wardId) return ['Choose an active bed belonging to the selected ward'];
    const state = inpatientBedState(bed.id, events, ready);
    if (state.status !== 'Available' && !(state.status === 'Reserved' && state.admission?.admissionId === event.admissionId)) return ['This bed is occupied, reserved or awaiting cleaning. Choose another bed'];
  }
  return [];
};
export const bedReadyIssues = (event: BedReadyEvent, records: Pick<InpatientRecords, 'events' | 'ready' | 'locations'>): string[] => {
  const release = records.events.find((item) => item.id === event.releaseEventId && item.facilityId === event.facilityId);
  if (!release || releasedBed(release, records.events) !== event.bedId) return ['Choose the bed released by this departure or transfer'];
  const state = inpatientBedState(event.bedId, records.events, records.ready);
  return state.status === 'Cleaning' && state.release?.id === event.releaseEventId ? [] : ['This bed no longer awaits this cleaning confirmation'];
};

/** Rejected events and their descendants never establish admission/bed state. */
export const usableInpatientEvents = (events: readonly InpatientEvent[], rejected: ReadonlySet<string>): InpatientEvent[] => {
  const blocked = new Set(rejected);
  const children = new Map<string, string[]>();
  for (const event of events) if (event.previousId) { const ids = children.get(event.previousId) ?? []; ids.push(event.id); children.set(event.previousId, ids); }
  const queue = [...blocked];
  for (let index = 0; index < queue.length; index++) for (const id of children.get(queue[index]) ?? []) if (!blocked.has(id)) { blocked.add(id); queue.push(id); }
  return events.filter((event) => !blocked.has(event.id));
};
