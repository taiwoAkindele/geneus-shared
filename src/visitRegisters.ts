import { dispositionHeads } from './careWorkflow.ts';
import { effectiveEncounterEntries } from './clinical.ts';
import { ENCOUNTER_STEP_VALUES, type Encounter, type EncounterEntry, type Patient, type RegisterDefinition, type RegisterEntry, type RegisterEntryValue, type RegisterVisitLink, type VisitFact } from './documents.ts';
import { labPatientFacts } from './resultTemplates.ts';

/**
 * Visit-linked registers are worked out from the visits themselves, on every
 * device the same way: nothing is copied, so a late result or a corrected
 * diagnosis shows in the register without anyone re-entering it. Staff record
 * only the fields a visit does not hold, as an entry naming the visit.
 */

export type VisitRegisterInput = {
  encounters: readonly Encounter[];
  entries: readonly EncounterEntry[];
  patients: readonly Patient[];
  /** This register's entries; those naming a visit complete its row. */
  completions?: readonly RegisterEntry[];
  staffNames?: ReadonlyMap<string, string>;
  /** The facility's calendar date for an instant. Defaults to the UTC date. */
  localDate?: (iso: string) => string;
};

export type VisitRegisterRow = {
  encounterId: string;
  patientId: string;
  /** The facility calendar date the visit opened, YYYY-MM-DD. */
  visitedOn: string;
  openedOn: string;
  values: Record<string, RegisterEntryValue>;
  /** The current staff entry for this visit, when one was recorded. */
  completion?: RegisterEntry;
  /** False while a staff-recorded field has no entry yet. */
  complete: boolean;
};

export const VISIT_FACT_LABELS: Record<VisitFact, string> = {
  visit_date: 'Visit date', patient_name: 'Patient name', patient_id: 'Patient ID', age: 'Age', sex: 'Sex',
  address: 'Address', phone: 'Phone', new_or_revisit: 'New or revisit', weight: 'Weight', temperature: 'Temperature',
  blood_pressure: 'Blood pressure', complaints: 'Complaints', diagnoses: 'Diagnoses', tests: 'Tests requested',
  results: 'Test results', medicines_prescribed: 'Medicines prescribed', medicines_dispensed: 'Medicines dispensed',
  outcome: 'Outcome', follow_up_date: 'Next visit date', seen_by: 'Seen by',
};

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Whether `text` mentions one of `words`, at the start of a word ("malaria"
 * finds "Malarial fever"). Short words must be the whole word, so "MP" finds
 * "MP test" but not "lump".
 */
export const mentionsAny = (text: string, words: readonly string[]): boolean => words.some((raw) => {
  const word = raw.trim();
  if (!word) return false;
  const end = word.length < 4 ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}${end}`, 'iu').test(text);
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const showDate = (date: string) => { const [y, m, d] = date.split('-'); return `${d} ${MONTHS[Number(m) - 1]} ${y}`; };
const OUTCOMES = { home_care: 'Sent home', observation: 'Under observation', referral: 'Referred', admission: 'Admitted' } as const;

const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];
const latest = (entries: readonly EncounterEntry[], step: EncounterEntry['step']) => last(entries.filter((entry) => entry.step === step));
const parsed = <S extends keyof typeof ENCOUNTER_STEP_VALUES>(entry: EncounterEntry | undefined, step: S) => {
  if (!entry) return undefined;
  const result = ENCOUNTER_STEP_VALUES[step].safeParse(entry.values);
  return result.success ? result.data as ReturnType<(typeof ENCOUNTER_STEP_VALUES)[S]['parse']> : undefined;
};
const all = <S extends keyof typeof ENCOUNTER_STEP_VALUES>(entries: readonly EncounterEntry[], step: S) =>
  entries.filter((entry) => entry.step === step).flatMap((entry) => { const values = parsed(entry, step); return values ? [values] : []; });

type VisitLists = { complaints: string[]; diagnoses: string[]; codes: string[]; tests: string[]; results: string[]; prescribed: string[]; dispensed: string[] };

const listsFor = (entries: readonly EncounterEntry[]): VisitLists => {
  const diagnosis = parsed(latest(entries, 'diagnosis'), 'diagnosis');
  const structured = diagnosis?.diagnoses ?? [];
  const prescription = parsed(latest(entries, 'prescription'), 'prescription');
  const lines = prescription ? prescription.prescription : diagnosis?.prescription ?? [];
  return {
    complaints: parsed(latest(entries, 'complaint'), 'complaint')?.complaints ?? [],
    diagnoses: structured.length ? structured.map((item) => item.code ? `${item.label} (${item.code})` : item.label) : diagnosis ? [diagnosis.diagnosis] : [],
    codes: structured.flatMap((item) => item.code ? [item.code] : []),
    tests: all(entries, 'lab_order').flatMap((order) => order.tests),
    results: all(entries, 'lab_results').flatMap((values) => values.results.map((row) => `${row.test}: ${row.result}`)),
    prescribed: lines.map((line) => [line.drug, line.dose].filter(Boolean).join(' ')),
    dispensed: (parsed(latest(entries, 'dispense'), 'dispense')?.lines ?? []).filter((line) => line.dispensed).map((line) => line.drug),
  };
};

/** Whether a visit belongs in a register linked to visits. */
export const visitMatchesLink = (link: RegisterVisitLink, entries: readonly EncounterEntry[]): boolean => {
  if (link.visits === 'every') return true;
  const lists = listsFor(effectiveEncounterEntries(entries));
  if (lists.codes.some((code) => link.codes.some((prefix) => code.toUpperCase().startsWith(prefix.toUpperCase())))) return true;
  return [...lists.diagnoses, ...lists.tests, ...lists.results].some((text) => mentionsAny(text, link.words));
};

const ageText = (patient: Patient, on: string) => {
  const age = labPatientFacts(patient, on).age;
  if (!age) return '';
  if (age.years >= 1 || age.months === undefined) return `${age.years} ${age.years === 1 ? 'year' : 'years'}`;
  if (age.months >= 1) return `${age.months} ${age.months === 1 ? 'month' : 'months'}`;
  return `${age.days ?? 0} ${age.days === 1 ? 'day' : 'days'}`;
};

const factFor = (fact: VisitFact, words: readonly string[] | undefined, context: {
  encounter: Encounter; entries: readonly EncounterEntry[]; patient?: Patient; visitedOn: string; first: boolean; names: ReadonlyMap<string, string>;
}): string => {
  const { encounter, entries, patient, visitedOn } = context;
  const narrow = (items: string[]) => (words?.length ? items.filter((item) => mentionsAny(item, words)) : items).join('; ');
  const vitals = parsed(latest(entries, 'vitals'), 'vitals');
  switch (fact) {
    case 'visit_date': return showDate(visitedOn);
    case 'patient_name': return patient?.fullName ?? '';
    case 'patient_id': return encounter.patientId;
    case 'age': return patient ? ageText(patient, visitedOn) : '';
    case 'sex': return patient?.sex ? patient.sex[0].toUpperCase() + patient.sex.slice(1) : '';
    case 'address': return patient?.address ?? '';
    case 'phone': return patient?.phone ?? '';
    case 'new_or_revisit': return context.first ? 'New' : 'Revisit';
    case 'weight': return vitals?.weightKg === undefined ? '' : `${vitals.weightKg} kg`;
    case 'temperature': return vitals?.temperatureC === undefined ? '' : `${vitals.temperatureC} °C`;
    case 'blood_pressure': return vitals?.systolicMmHg === undefined || vitals.diastolicMmHg === undefined ? '' : `${vitals.systolicMmHg}/${vitals.diastolicMmHg} mmHg`;
    case 'complaints': return narrow(listsFor(entries).complaints);
    case 'diagnoses': return narrow(listsFor(entries).diagnoses);
    case 'tests': return narrow(listsFor(entries).tests);
    case 'results': return narrow(listsFor(entries).results);
    case 'medicines_prescribed': return narrow(listsFor(entries).prescribed);
    case 'medicines_dispensed': return narrow(listsFor(entries).dispensed);
    case 'outcome': {
      const disposition = last(dispositionHeads(entries));
      if (disposition) return OUTCOMES[disposition.values.kind as keyof typeof OUTCOMES] ?? '';
      if (latest(entries, 'admission')) return OUTCOMES.admission;
      return latest(entries, 'follow_up') ? OUTCOMES.home_care : '';
    }
    case 'follow_up_date': {
      const disposition = last(dispositionHeads(entries));
      const date = typeof disposition?.values.followUpOn === 'string' ? disposition.values.followUpOn : parsed(latest(entries, 'follow_up'), 'follow_up')?.followUpOn;
      return date ? showDate(date) : '';
    }
    case 'seen_by': {
      const author = (latest(entries, 'diagnosis') ?? latest(entries, 'complaint'))?.createdBy;
      return author ? context.names.get(author) ?? '' : '';
    }
  }
};

/** A visit-linked register's rows, newest visit first. Other registers have none. */
export const visitRegisterRows = (definition: Pick<RegisterDefinition, 'registerId' | 'fields' | 'visitLink'>, input: VisitRegisterInput): VisitRegisterRow[] => {
  const link = definition.visitLink;
  if (!link) return [];
  const localDate = input.localDate ?? ((iso: string) => iso.slice(0, 10));
  const names = input.staffNames ?? new Map<string, string>();
  const patients = new Map(input.patients.map((patient) => [patient.patientId, patient]));
  const byVisit = new Map<string, EncounterEntry[]>();
  for (const entry of input.entries) { const group = byVisit.get(entry.encounterId) ?? []; group.push(entry); byVisit.set(entry.encounterId, group); }
  const firstVisit = new Map<string, Encounter>();
  for (const encounter of input.encounters) {
    const first = firstVisit.get(encounter.patientId);
    if (!first || encounter.openedOn < first.openedOn || (encounter.openedOn === first.openedOn && encounter.id < first.id)) firstVisit.set(encounter.patientId, encounter);
  }
  const completions = new Map<string, RegisterEntry>();
  for (const entry of [...(input.completions ?? [])].sort((a, b) => a.createdOn.localeCompare(b.createdOn) || a.id.localeCompare(b.id))) {
    if (entry.registerId === definition.registerId && entry.encounterId) completions.set(entry.encounterId, entry);
  }
  const staffFields = definition.fields.filter((field) => field.type !== 'section' && !field.fromVisit);
  const seen = new Set<string>();
  const rows: VisitRegisterRow[] = [];
  for (const encounter of input.encounters) {
    if (seen.has(encounter.id)) continue;
    seen.add(encounter.id);
    const entries = effectiveEncounterEntries(byVisit.get(encounter.id) ?? []);
    if (!visitMatchesLink(link, entries)) continue;
    const visitedOn = localDate(encounter.openedOn);
    const context = { encounter, entries, patient: patients.get(encounter.patientId), visitedOn, first: firstVisit.get(encounter.patientId)?.id === encounter.id, names };
    const completion = completions.get(encounter.id);
    const values: Record<string, RegisterEntryValue> = {};
    for (const field of definition.fields) {
      if (field.type === 'section') continue;
      if (field.fromVisit) values[field.id] = factFor(field.fromVisit.fact, field.fromVisit.words, context);
      else if (completion && completion.values[field.id] !== undefined) values[field.id] = completion.values[field.id];
    }
    rows.push({ encounterId: encounter.id, patientId: encounter.patientId, visitedOn, openedOn: encounter.openedOn, values, ...(completion ? { completion } : {}), complete: !staffFields.length || Boolean(completion) });
  }
  return rows.sort((a, b) => b.openedOn.localeCompare(a.openedOn) || b.encounterId.localeCompare(a.encounterId));
};
