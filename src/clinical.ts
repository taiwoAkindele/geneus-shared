import { z } from 'zod';
import { baseEnvelope, isoDate, patientId } from './common.ts';
import { ENCOUNTER_STEP_VALUES, Role, type EncounterEntry, type Patient } from './documents.ts';

const text = z.string().trim().min(1).max(5000);
const optionalText = text.optional();
const date = isoDate.refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'Enter a valid date');
export const ClinicalKind = z.enum(['problem', 'history', 'medication', 'allergy', 'care_plan', 'specialty']);
export type ClinicalKind = z.infer<typeof ClinicalKind>;

export const CLINICAL_VALUES = {
  problem: z.strictObject({
    label: text, code: optionalText, codingSystem: z.enum(['ICD-10', 'SNOMED CT', 'local']).optional(),
    status: z.enum(['active', 'resolved', 'inactive']), certainty: z.enum(['unknown', 'suspected', 'confirmed']),
    onsetOn: date.optional(), resolvedOn: date.optional(), note: optionalText,
  }).refine((v) => !v.onsetOn || !v.resolvedOn || v.resolvedOn >= v.onsetOn, 'Resolution must not precede onset')
    .refine((v) => !v.code || Boolean(v.codingSystem), 'Choose the coding system for this diagnosis code'),
  history: z.strictObject({
    medical: optionalText, surgical: optionalText, family: optionalText, social: optionalText,
    examination: optionalText, note: optionalText,
  }).refine((v) => Object.values(v).some(Boolean), 'Record at least one history or examination field'),
  medication: z.strictObject({
    drug: text, dose: text, frequency: text, duration: optionalText, route: optionalText,
    status: z.enum(['active', 'stopped', 'completed']), startedOn: date.optional(), stoppedOn: date.optional(),
    indication: optionalText, problemId: optionalText, reconciliationNote: optionalText,
  }).refine((v) => !v.startedOn || !v.stoppedOn || v.stoppedOn >= v.startedOn, 'Stop date must not precede start date'),
  allergy: z.strictObject({
    allergen: text, reaction: text, severity: z.enum(['unknown', 'mild', 'moderate', 'severe']),
    verification: z.enum(['reported', 'confirmed', 'refuted']), status: z.enum(['active', 'inactive']), note: optionalText,
  }),
  care_plan: z.strictObject({
    title: text, problemId: optionalText, goal: text, actions: text,
    status: z.enum(['active', 'completed', 'cancelled']), reviewOn: date.optional(), outcome: optionalText,
  }),
  specialty: z.strictObject({
    specialty: z.enum(['general', 'antenatal', 'paediatrics', 'diabetes', 'hypertension']),
    assessment: text, findings: optionalText, plan: text, reviewOn: date.optional(), outcome: optionalText,
    status: z.enum(['active', 'completed']),
    measurements: z.record(z.string().min(1).max(80), z.string().trim().max(500)).default({}),
  }),
} as const satisfies Record<ClinicalKind, z.ZodType>;
export type ClinicalValues = { [K in ClinicalKind]: z.infer<(typeof CLINICAL_VALUES)[K]> };

/** Each update names the version it replaces. The server refuses forks rather than losing clinical work. */
export const ClinicalEvent = baseEnvelope.extend({
  type: z.literal('clinical_event'), patientId, encounterId: text.optional(),
  recordId: text, previousId: text.optional(), kind: ClinicalKind, actorRole: Role,
  values: z.record(z.string(), z.unknown()),
}).superRefine((event, context) => {
  if (event.previousId === event.id) context.addIssue({ code: 'custom', path: ['previousId'], message: 'A revision cannot replace itself' });
  const result = CLINICAL_VALUES[event.kind].safeParse(event.values);
  if (!result.success) for (const issue of result.error.issues) context.addIssue({ code: 'custom', path: ['values', ...issue.path], message: issue.message });
});
export type ClinicalEvent = z.infer<typeof ClinicalEvent>;

/** Causal order, independent of device clocks. A local fork stays visible until reconciled. */
export const currentClinicalEvents = (events: readonly ClinicalEvent[]): ClinicalEvent[] => {
  const replaced = new Set(events.flatMap((event) => event.previousId ? [event.previousId] : []));
  return events.filter((event) => !replaced.has(event.id)).sort((a, b) => a.recordId.localeCompare(b.recordId) || a.id.localeCompare(b.id));
};

type AllergyPatient = Pick<Patient, 'patientId' | 'allergies'>;
const allergyKey = (patientId: string, allergen: string) => `${patientId}|${allergen.trim().toLowerCase()}`;

/** A clinician can review a legacy allergy without rewriting the original demographic record. */
export const unreviewedLegacyAllergies = (events: readonly ClinicalEvent[], patients: readonly AllergyPatient[]) => {
  const reviewed = new Set(currentClinicalEvents(events).filter((event) => event.kind === 'allergy')
    .map((event) => allergyKey(event.patientId, String(event.values.allergen))));
  return patients.flatMap((patient) => patient.allergies.filter((allergen) => !reviewed.has(allergyKey(patient.patientId, allergen)))
    .map((allergen) => ({ patientId: patient.patientId, allergen })));
};

export const currentAllergies = (events: readonly ClinicalEvent[], patients: readonly AllergyPatient[] = []) => {
  const structured = currentClinicalEvents(events).filter((event) => event.kind === 'allergy').flatMap((event) => {
    const parsed = CLINICAL_VALUES.allergy.safeParse(event.values);
    return parsed.success && parsed.data.status === 'active' && parsed.data.verification !== 'refuted'
      ? [{ ...parsed.data, patientId: event.patientId, legacy: false }] : [];
  });
  const legacy = unreviewedLegacyAllergies(events, patients).map((allergy) => ({
    ...allergy, reaction: 'Reaction not recorded', severity: 'unknown' as const,
    verification: 'reported' as const, status: 'active' as const, legacy: true,
  }));
  return [...structured, ...legacy];
};

/** Structured amendments replace displayed values only; originals remain immutable and inspectable. */
export const effectiveEncounterEntries = (entries: readonly EncounterEntry[]): EncounterEntry[] => {
  const byTime = [...entries].sort((a, b) => a.createdOn.localeCompare(b.createdOn) || a.id.localeCompare(b.id));
  const correctionsByEntry = new Map<string, EncounterEntry[]>();
  const replaced = new Set<string>();
  for (const amendment of byTime) {
    if (amendment.step !== 'amendment' || !amendment.amends || !amendment.values.correctedValues) continue;
    const corrections = correctionsByEntry.get(amendment.amends) ?? [];
    corrections.push(amendment);
    correctionsByEntry.set(amendment.amends, corrections);
    if (typeof amendment.values.previousAmendmentId === 'string') replaced.add(amendment.values.previousAmendmentId);
  }
  return byTime.filter((entry) => entry.step !== 'amendment').map((entry) => {
    let values = entry.values;
    const corrections = correctionsByEntry.get(entry.id) ?? [];
    for (const amendment of corrections.filter((amendment) => !replaced.has(amendment.id))) {
      const parsed = ENCOUNTER_STEP_VALUES[entry.step].safeParse(amendment.values.correctedValues);
      if (parsed.success) values = parsed.data as Record<string, unknown>;
    }
    return { ...entry, values };
  });
};

export const conflictingCorrections = (entries: readonly EncounterEntry[]): string[] => {
  const corrections = entries.filter((entry) => entry.step === 'amendment' && entry.values.correctedValues);
  const replaced = new Set(corrections.map((entry) => entry.values.previousAmendmentId));
  const targets = new Map<string, number>();
  for (const correction of corrections) if (correction.amends && !replaced.has(correction.id)) targets.set(correction.amends, (targets.get(correction.amends) ?? 0) + 1);
  return [...targets].filter(([, count]) => count > 1).map(([id]) => id);
};

/** Shared display vocabulary, not clinical recommendations or treatment protocols. */
export const SPECIALTY_FIELDS = {
  general: ['Symptoms', 'Examination'],
  antenatal: ['Gestational age (weeks)', 'Gravidity / parity', 'Obstetric findings'],
  paediatrics: ['Height / length (cm)', 'Head circumference (cm)', 'Development', 'Feeding'],
  diabetes: ['Blood glucose (value and unit)', 'HbA1c (%)', 'Foot examination', 'Adherence'],
  hypertension: ['Home BP readings', 'Cardiovascular history', 'Adherence'],
} as const;
