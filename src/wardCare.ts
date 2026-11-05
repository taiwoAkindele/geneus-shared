import { z } from 'zod';
import { baseEnvelope, isoDate, isoDateTime } from './common.ts';
import { ClinicalActorContext, type ClinicalAction } from './facilityTypes.ts';
import { PrescriptionLine, type Encounter, type EncounterEntry } from './documents.ts';
import { activeAdmission, inpatientHeads, type InpatientEvent } from './inpatient.ts';
import { effectiveEncounterEntries } from './clinical.ts';
import type { ClinicalEvent } from './clinical.ts';
import { encounterClinicalActions, clinicalEventActions } from './facilityAuthorization.ts';
import { validCalendarDate } from './patientIdentity.ts';

export const WARD_CARE_VERSION = 1 as const;
const text = z.string().trim().min(1).max(8000);
const ref = z.string().trim().min(1).max(200);
export const WardCareValues = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('complete'), note: text.optional() }),
  z.strictObject({ kind: z.literal('medication'), orderId: ref, previousId: ref.optional(), action: z.enum(['start', 'continue', 'change', 'stop']), sourceEntryId: ref, lineId: ref, note: text.optional() }),
  z.strictObject({ kind: z.literal('administration'), orderEventId: ref, dose: text, route: text.optional(), outcome: z.enum(['given', 'not_given']), reason: text.optional(), previousId: ref.optional() })
    .refine((v) => v.outcome === 'given' || Boolean(v.reason), 'Give a reason for a medicine not given'),
  z.strictObject({ kind: z.literal('discharge'), previousId: ref.optional(), admissionReason: text, diagnoses: text, course: text, findings: text.optional(), pending: text.optional(), instructions: text,
    takeHome: z.array(PrescriptionLine).max(100), followUpOn: isoDate.refine(validCalendarDate, 'Enter a valid follow-up date').optional(), appointmentId: ref.optional(), sourceEntryIds: z.array(ref).max(2000).refine((ids) => new Set(ids).size === ids.length, 'Reference each source once'),
    sourceWardEventIds: z.array(ref).max(2000).default([]),
    patientName: text, patientIdentifier: ref, admittedOn: isoDateTime,
  }),
]);
export type WardCareValues = z.infer<typeof WardCareValues>;
export const WardCareEvent = baseEnvelope.extend({
  type: z.literal('ward_care_event'), admissionId: ref, encounterId: ref, patientId: ref,
  occurredOn: isoDateTime, actorContext: ClinicalActorContext.optional(), lateReason: text.optional(), values: WardCareValues,
});
export type WardCareEvent = z.infer<typeof WardCareEvent>;
export const wardClinicalActions = (event: WardCareEvent): ClinicalAction[] => event.values.kind === 'medication' ? ['prescribe']
  : event.values.kind === 'administration' ? ['administer'] : event.values.kind === 'discharge' ? ['assess', 'prescribe'] : [];
export type ClinicalRecord = EncounterEntry | ClinicalEvent | WardCareEvent;
export const clinicalPerformedOn = (record: ClinicalRecord): string => record.type === 'ward_care_event'
  ? record.values.kind === 'administration' && record.values.previousId ? record.createdOn : record.occurredOn
  : record.type === 'encounter_entry' && record.step !== 'amendment' ? record.performedOn ?? record.createdOn : record.createdOn;
export const clinicalRecordActions = (record: ClinicalRecord, original?: EncounterEntry): ClinicalAction[] => record.type === 'ward_care_event'
  ? wardClinicalActions(record) : record.type === 'encounter_entry' ? encounterClinicalActions(record, original) : clinicalEventActions(record);

export type WardRecords = { admissions: readonly InpatientEvent[]; encounters: readonly Encounter[]; entries: readonly EncounterEntry[]; events: readonly WardCareEvent[] };
export const wardAdmission = (records: WardRecords, id: string) => inpatientHeads(records.admissions.filter((e) => e.admissionId === id));
export const wardSessionComplete = (id: string, events: readonly WardCareEvent[]) => events.some((e) => e.encounterId === id && e.values.kind === 'complete');
export const medicationHeads = (events: readonly WardCareEvent[]) => {
  const orders = events.filter((e) => e.values.kind === 'medication');
  const replaced = new Set(orders.flatMap((e) => e.values.kind === 'medication' && e.values.previousId ? [e.values.previousId] : []));
  return orders.filter((e) => !replaced.has(e.id));
};
export const dischargeHeads = (events: readonly WardCareEvent[]) => {
  const summaries = events.filter((e) => e.values.kind === 'discharge');
  const replaced = new Set(summaries.flatMap((e) => e.values.kind === 'discharge' && e.values.previousId ? [e.values.previousId] : []));
  return summaries.filter((e) => !replaced.has(e.id));
};
export const orderLine = (order: WardCareEvent, entries: readonly EncounterEntry[]) => {
  if (order.values.kind !== 'medication') return undefined;
  const value = order.values;
  const entry = entries.find((e) => e.id === value.sourceEntryId && ['prescription','diagnosis'].includes(e.step));
  return entry ? wardPrescriptionLines(entry).find((line) => line.lineId === value.lineId) : undefined;
};
export const wardPrescriptionLines = (entry: EncounterEntry): z.infer<typeof PrescriptionLine>[] =>
  ((entry.values.prescription ?? []) as z.infer<typeof PrescriptionLine>[]).map((line, index) => ({ ...line, lineId: line.lineId ?? `${entry.id}:line:${index}` }));

export const wardSessionIssues = (encounter: Encounter, records: WardRecords, allowHistoricalContext = false): string[] => {
  const ctx = encounter.inpatientContext;
  if (!ctx) return [];
  const heads = wardAdmission(records, ctx.admissionId);
  if (!records.admissions.some((e) => e.id === ctx.admissionId && e.action === 'confirm')) return ['The source admission has not been accepted'];
  if (heads.length !== 1 || heads[0].facilityId !== encounter.facilityId || heads[0].patientId !== encounter.patientId) return ['Choose this patient’s admission in this hospital'];
  if (!activeAdmission(heads[0]) && !allowHistoricalContext) return ['This admission has ended; retain late care for explicit review'];
  if (encounter.appointmentId || encounter.collectLaterReason || encounter.visitType) return ['Ward care is not a new appointment or outpatient attendance'];
  return [];
};

/** The same state checks run under the local write lock and the facility lock on upload. */
export const wardEventIssues = (event: WardCareEvent, records: WardRecords, allowLate = false): string[] => {
  const { values: v } = event;
  const heads = wardAdmission(records, event.admissionId);
  if (!records.admissions.some((e) => e.id === event.admissionId && e.action === 'confirm')) return ['The source admission has not been accepted'];
  const session = records.encounters.find((e) => e.id === event.encounterId);
  if (heads.length !== 1 || heads[0].patientId !== event.patientId || heads[0].facilityId !== event.facilityId
    || !session || session.patientId !== event.patientId || session.facilityId !== event.facilityId || session.inpatientContext?.admissionId !== event.admissionId) return ['Ward care must reference this patient, admission and hospital'];
  const events = records.events.filter((e) => e.admissionId === event.admissionId && e.facilityId === event.facilityId);
  const entries = records.entries.filter((e) => e.patientId === event.patientId && e.facilityId === event.facilityId);
  if (!activeAdmission(heads[0]) && !allowLate) return ['The stay has ended; original late documentation needs independent review'];
  if (Date.parse(event.occurredOn) > Date.parse(event.createdOn) + 300000) return ['Actual care time cannot be in the future'];
  if (Date.parse(event.occurredOn) < Date.parse(records.admissions.find((e) => e.id === event.admissionId)!.createdOn)) return ['Actual care time cannot precede admission'];
  if (v.kind === 'complete') {
    if (wardSessionComplete(event.encounterId, events)) return ['This care activity is already completed'];
    if (!entries.some((e) => e.encounterId === event.encounterId) && !events.some((e) => e.encounterId === event.encounterId)) return ['Record care before completing the activity'];
  }
  if (v.kind === 'medication') {
    if (session.inpatientContext.purpose !== 'review') return ['Open a doctor review for medication decisions'];
    if (wardSessionComplete(event.encounterId, events)) return ['Start a new review to change a completed activity'];
    const source = entries.find((e) => e.id === v.sourceEntryId && ['prescription','diagnosis'].includes(e.step));
    const line = orderLine(event, entries);
    if (!source || !line) return ['Choose an exact signed prescription line from this stay'];
    const sourceSession = records.encounters.find((e) => e.id === source.encounterId);
    if (sourceSession?.inpatientContext?.admissionId !== event.admissionId && sourceSession?.id !== heads[0].encounterId) return ['The prescription belongs to another stay'];
    if (v.action !== 'stop' && entries.some((e) => e.step === 'amendment' && e.amends === source.id && e.values.correctedValues)) return ['The source prescription was corrected; review it and sign a new medication decision'];
    const prior = events.find((e) => e.id === v.previousId);
    if (v.action === 'start') {
      if (v.orderId !== event.id || v.previousId || events.some((e) => e.values.kind === 'medication' && e.values.orderId === v.orderId)) return ['A new order starts a distinct history'];
      if (events.some((e) => e.values.kind === 'medication' && e.values.sourceEntryId === v.sourceEntryId && e.values.lineId === v.lineId)) return ['This prescription line already has a medication order'];
    } else {
      if (!prior || prior.values.kind !== 'medication' || prior.values.orderId !== v.orderId || prior.values.action === 'stop') return ['Review the current active medication order'];
      if (events.some((e) => e.values.kind === 'medication' && e.values.previousId === prior.id)) return ['This order has changed; review its latest decision'];
      if (v.action !== 'change' && (prior.values.sourceEntryId !== v.sourceEntryId || prior.values.lineId !== v.lineId)) return ['Continue or stop must preserve the exact prescribed instructions'];
      if (v.action === 'change' && source.encounterId !== event.encounterId) return ['A changed order must reference this review’s new prescription'];
    }
  }
  if (v.kind === 'administration') {
    const order = events.find((e) => e.id === v.orderEventId);
    if (!order || order.values.kind !== 'medication' || order.values.action === 'stop' || !orderLine(order, entries)) return ['Choose a signed active medication order'];
    if (!allowLate && !v.previousId && entries.some((e) => e.step === 'amendment' && order.values.kind === 'medication' && e.amends === order.values.sourceEntryId && e.values.correctedValues)) return ['The source prescription was corrected; review medication before another administration'];
    const current = medicationHeads(events).filter((e) => e.values.kind === 'medication' && order.values.kind === 'medication' && e.values.orderId === order.values.orderId);
    if (!allowLate && !v.previousId && (current.length !== 1 || current[0].id !== order.id)) return ['The medication order changed or conflicts; review it before recording administration'];
    const previous = events.find((e) => e.id === v.previousId);
    if (v.previousId && (!previous || previous.values.kind !== 'administration' || previous.values.orderEventId !== v.orderEventId || Date.parse(previous.occurredOn) !== Date.parse(event.occurredOn)
      || events.some((e) => e.values.kind === 'administration' && e.values.previousId === previous.id))) return ['A correction must continue the same administration and actual time'];
    if (!v.previousId && events.some((e) => e.values.kind === 'administration' && e.values.orderEventId === v.orderEventId && Date.parse(e.occurredOn) === Date.parse(event.occurredOn))) return ['A dose is already recorded at this time; review it or add a correction'];
  }
  if (v.kind === 'discharge') {
    if (session.inpatientContext.purpose !== 'discharge') return ['Use a discharge review to sign this summary'];
    const previous = dischargeHeads(events);
    if ((previous.length > 0 && (previous.length !== 1 || previous[0].id !== v.previousId)) || (!previous.length && v.previousId)) return ['The discharge summary changed; review its current revision'];
    const stayEncounterIds = new Set(records.encounters.filter((e) => e.inpatientContext?.admissionId === event.admissionId || e.id === heads[0].encounterId).map((e) => e.id));
    if (!v.sourceEntryIds.length || v.sourceEntryIds.some((id) => !entries.some((e) => e.id === id && stayEncounterIds.has(e.encounterId)))) return ['Summary sources must be signed records from this stay'];
    if (v.sourceWardEventIds.some((id) => !events.some((e) => e.id === id))) return ['Summary order and administration sources must belong to this stay'];
    const admitted = records.admissions.find((e) => e.id === event.admissionId);
    if (v.patientIdentifier !== event.patientId || v.admittedOn !== admitted?.createdOn) return ['Keep the original patient and admission identity on the summary'];
  }
  return [];
};

export const wardEntryIssues = (encounter: Encounter, entry: EncounterEntry, records: WardRecords, allowLate = false): string[] => {
  if (!encounter.inpatientContext) return entry.admissionId ? ['An outpatient entry cannot name a ward stay'] : [];
  if (entry.admissionId !== encounter.inpatientContext.admissionId) return ['Care entry must retain its admission context'];
  const heads = wardAdmission(records, entry.admissionId);
  if (!records.admissions.some((e) => e.id === entry.admissionId && e.action === 'confirm')) return ['The source admission is not available'];
  if (heads.length !== 1 || heads[0].patientId !== entry.patientId || heads[0].facilityId !== entry.facilityId || encounter.patientId !== entry.patientId) return ['Choose this patient’s admission and care activity'];
  if (entry.performedOn && (Date.parse(entry.performedOn) > Date.parse(entry.createdOn) + 300000 || Date.parse(entry.performedOn) < Date.parse(records.admissions.find((e) => e.id === entry.admissionId)!.createdOn))) return ['Actual care time must be within the stay and not in the future'];
  const sessionIssues = wardSessionIssues(encounter, records);
  if (sessionIssues.length && !allowLate) return sessionIssues;
  if (['admission', 'follow_up', 'disposition'].includes(entry.step)) return ['Complete the care activity without closing or readmitting the stay'];
  if (wardSessionComplete(encounter.id, records.events) && !['amendment','lab_results','result_review','dispense','injection'].includes(entry.step)) return ['This activity is completed; start another review or correct the original'];
  const prior = effectiveEncounterEntries(records.entries.filter((e) => e.encounterId === encounter.id));
  if (entry.step === 'diagnosis' && !prior.some((e) => e.step === 'complaint')) return ['Record the assessment for this review before its diagnosis'];
  if (entry.step === 'prescription' && !prior.some((e) => ['complaint','diagnosis'].includes(e.step))) return ['Record this review’s assessment before treatment'];
  if (entry.step === 'prescription' && (entry.values.prescription as { lineId?: string }[]).some((line) => !line.lineId)) return ['Ward prescription lines need stable identities'];
  if (entry.step === 'prescription') { const ids = (entry.values.prescription as { lineId: string }[]).map((line) => line.lineId); if (new Set(ids).size !== ids.length) return ['Each prescribed medicine needs a distinct line identity']; }
  if (encounter.inpatientContext.purpose === 'nursing' && ['prescription','diagnosis','injection_order','lab_order','investigation_review'].includes(entry.step)) return ['Open a doctor review for new treatment decisions'];
  return [];
};

export const wardReadinessIssues = (event: InpatientEvent, events: readonly WardCareEvent[], enabled: boolean): string[] => {
  if (!['ready_for_discharge','discharge'].includes(event.action)) return [];
  if (event.departureException) return [];
  if (!enabled && !event.dischargeSummaryId) return [];
  const heads = dischargeHeads(events.filter((e) => e.admissionId === event.admissionId && e.facilityId === event.facilityId));
  if (heads.length !== 1 || heads[0].id !== event.dischargeSummaryId || heads[0].values.kind !== 'discharge') return ['Review and sign the current discharge summary, or record a departure exception'];
  const snapshot = heads[0].values;
  if (medicationHeads(events.filter((e) => e.admissionId === event.admissionId && e.facilityId === event.facilityId)).some((e) => !snapshot.sourceWardEventIds.includes(e.id))) return ['Medication decisions changed after the discharge summary; review and sign a revised summary'];
  return [];
};
