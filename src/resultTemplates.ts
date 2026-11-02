/**
 * Geneus Health — shared contract: lab result templates and structured results.
 *
 * A result template lists the parts a lab enters for a test (Haemoglobin, an
 * answer from a list, a culture, a report section, images), and one template
 * can serve many tests. Templates, the shared parts library and answer lists are
 * written by the server only; devices receive them read-only so results can be
 * entered offline. Every saved template revision is kept, and a published result
 * names the revision it was entered against, so later edits never change it.
 *
 * Ranges are chosen for the patient's sex and age, but the system never flags a
 * value: a flag is the scientist's own, optional choice.
 */
import { z } from 'zod';
import { baseEnvelope, Sex } from './common.ts';
import { DocumentFile } from './documentFiles.ts';
import { patientAge } from './patientIdentity.ts';

const text = z.string().trim().min(1);
const name = text.max(160);
const ref = text.max(200);
const revision = z.number().int().positive();
/** Settings records carry the current envelope; only the server writes them. */
const record = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...baseEnvelope.shape, schemaVersion: z.literal(5).default(5), ...shape });
const distinct = (max: number, what: string) => z.array(text.max(120)).max(max).refine((v) => new Set(v).size === v.length, `List each ${what} only once`);

/* ------------------------------------------------------------------ */
/* Normal ranges                                                       */
/* ------------------------------------------------------------------ */

export const AgeUnit = z.enum(['days', 'months', 'years']);
export type AgeUnit = z.infer<typeof AgeUnit>;
export const AgeBound = z.strictObject({ value: z.number().int().nonnegative().max(50_000), unit: AgeUnit });
export type AgeBound = z.infer<typeof AgeBound>;
const DAYS_PER: Record<AgeUnit, number> = { days: 1, months: 30.4375, years: 365.25 };
const approxDays = (bound?: AgeBound) => bound ? bound.value * DAYS_PER[bound.unit] : undefined;

/**
 * One row of a part's normal ranges. No sex means anyone; `ageFrom` is included
 * and `ageTo` is not, so 5 to 18 years ends the day before the 18th birthday.
 */
export const ReferenceRange = z.strictObject({
  sex: Sex.optional(), ageFrom: AgeBound.optional(), ageTo: AgeBound.optional(),
  low: z.number().optional(), high: z.number().optional(),
}).superRefine((range, ctx) => {
  if (range.low === undefined && range.high === undefined) ctx.addIssue({ code: 'custom', path: ['low'], message: 'Give a low or a high value for this range' });
  if (range.low !== undefined && range.high !== undefined && range.low >= range.high) ctx.addIssue({ code: 'custom', path: ['high'], message: 'The high value must be above the low value' });
  if (range.ageFrom && range.ageTo && approxDays(range.ageFrom)! >= approxDays(range.ageTo)!) ctx.addIssue({ code: 'custom', path: ['ageTo'], message: 'The age band must end after it starts' });
});
export type ReferenceRange = z.infer<typeof ReferenceRange>;

/** Two rows that could both describe one patient. Mixed age units compare by average length. */
export const rangesOverlap = (a: ReferenceRange, b: ReferenceRange): boolean => {
  if (a.sex && b.sex && a.sex !== b.sex) return false;
  const start = (r: ReferenceRange) => approxDays(r.ageFrom) ?? 0, end = (r: ReferenceRange) => approxDays(r.ageTo) ?? Infinity;
  return start(a) < end(b) && start(b) < end(a);
};

/* ------------------------------------------------------------------ */
/* Template parts                                                      */
/* ------------------------------------------------------------------ */

export const PartKey = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, 'Use lower-case letters, digits and underscores for a part key');
const partBase = { key: PartKey, label: name, required: z.boolean().default(false), libraryPartId: ref.optional() };
export const NumberPart = z.strictObject({
  ...partBase, kind: z.literal('number'), unit: text.max(40).optional(),
  decimals: z.number().int().min(0).max(4).default(1), ranges: z.array(ReferenceRange).max(40).default([]),
}).superRefine((part, ctx) => part.ranges.forEach((a, i) => part.ranges.slice(i + 1).forEach((b, j) => {
  if (rangesOverlap(a, b)) ctx.addIssue({ code: 'custom', path: ['ranges', i + 1 + j], message: 'Two ranges cover the same patients. Change the sex or age so they do not overlap' });
})));
export const ChoicePart = z.strictObject({
  ...partBase, kind: z.literal('choice'), answers: distinct(50, 'answer').refine((v) => v.length >= 2, 'Give at least two answers'), answerListId: ref.optional(),
});
export const TextPart = z.strictObject({ ...partBase, kind: z.literal('text') });
/** A titled block of report prose, such as Findings or Impression. */
export const SectionPart = z.strictObject({ ...partBase, kind: z.literal('section') });
export const CulturePart = z.strictObject({ ...partBase, kind: z.literal('culture'), antibiotics: distinct(80, 'antibiotic') });
export const ImagesPart = z.strictObject({ ...partBase, kind: z.literal('images'), maxFiles: z.number().int().min(1).max(12).default(6) });
export const ResultPart = z.discriminatedUnion('kind', [NumberPart, ChoicePart, TextPart, SectionPart, CulturePart, ImagesPart]);
export type ResultPart = z.infer<typeof ResultPart>;
export type NumberPart = z.infer<typeof NumberPart>;
export const RESULT_PART_KIND_LABELS = { number: 'Number', choice: 'Choice', text: 'Text', section: 'Report section', culture: 'Culture', images: 'Images' } as const satisfies Record<ResultPart['kind'], string>;

/** A test with no template is entered as one free-text result. */
export const TEXT_RESULT_PART = { key: 'result', label: 'Result', kind: 'text', required: true } as const satisfies ResultPart;

/* ------------------------------------------------------------------ */
/* Settings records                                                    */
/* ------------------------------------------------------------------ */

export const ResultTemplateStatus = z.enum(['draft', 'active', 'archived']);
export type ResultTemplateStatus = z.infer<typeof ResultTemplateStatus>;
const templateFields = {
  name, status: ResultTemplateStatus, parts: z.array(ResultPart).min(1).max(80),
  /** "Used by": the catalogue tests entered with this template. A test belongs to at most one. */
  serviceDefinitionIds: z.array(ref).max(500).refine((v) => new Set(v).size === v.length, 'Choose each test only once'),
};
const checkTemplate = (template: { status: ResultTemplateStatus; parts: ResultPart[]; serviceDefinitionIds: string[] }, ctx: z.RefinementCtx) => {
  const keys = template.parts.map((part) => part.key);
  keys.forEach((key, i) => { if (keys.indexOf(key) !== i) ctx.addIssue({ code: 'custom', path: ['parts', i, 'key'], message: 'Each part needs its own key' }); });
  if (template.status !== 'active' && template.serviceDefinitionIds.length) ctx.addIssue({ code: 'custom', path: ['serviceDefinitionIds'], message: 'Only a template that is in use can be linked to tests' });
};
/** What a settings screen sends; the server adds identity, source and revision. */
export const ResultTemplateDraft = z.strictObject(templateFields).superRefine(checkTemplate);
export type ResultTemplateDraft = z.infer<typeof ResultTemplateDraft>;
export const ResultTemplate = record({
  type: z.literal('result_template'), ...templateFields,
  source: z.enum(['standard', 'own']), standardKey: text.max(80).optional(), revision: revision.default(1),
}).superRefine(checkTemplate);
export type ResultTemplate = z.infer<typeof ResultTemplate>;

/** A shared part: changing it updates every template that uses it, as a new template revision. */
export const ResultPartDraft = z.strictObject({ part: ResultPart, active: z.boolean().default(true) });
export type ResultPartDraft = z.infer<typeof ResultPartDraft>;
export const ResultPartDefinition = record({ type: z.literal('result_part'), ...ResultPartDraft.shape, revision: revision.default(1) });
export type ResultPartDefinition = z.infer<typeof ResultPartDefinition>;

export const AnswerListDraft = z.strictObject({ name, answers: distinct(50, 'answer').refine((v) => v.length >= 2, 'Give at least two answers'), active: z.boolean().default(true) });
export type AnswerListDraft = z.infer<typeof AnswerListDraft>;
export const AnswerList = record({ type: z.literal('answer_list'), ...AnswerListDraft.shape, revision: revision.default(1) });
export type AnswerList = z.infer<typeof AnswerList>;

/** The kind of result a template records, as the settings list shows it. */
export const templateResultType = (parts: readonly ResultPart[]): 'Numbers' | 'Choice' | 'Text' | 'Culture' | 'Report' | 'Mixed' => {
  const kinds = new Set(parts.map((part) => part.kind));
  if (kinds.has('culture')) return 'Culture';
  if (kinds.has('section') || kinds.has('images')) return 'Report';
  if (kinds.size === 1) return kinds.has('number') ? 'Numbers' : kinds.has('choice') ? 'Choice' : 'Text';
  return 'Mixed';
};

/** The template in use for a catalogue test, if it has one. */
export const templateForTest = <T extends Pick<ResultTemplate, 'status' | 'serviceDefinitionIds'>>(templates: readonly T[], serviceDefinitionId: string | undefined): T | undefined =>
  serviceDefinitionId ? templates.find((template) => template.status === 'active' && template.serviceDefinitionIds.includes(serviceDefinitionId)) : undefined;

/* ------------------------------------------------------------------ */
/* Structured results                                                  */
/* ------------------------------------------------------------------ */

/** The scientist's own reading of a value. Optional, and never set by the system. */
export const ResultFlag = z.enum(['normal', 'abnormal', 'high', 'low', 'critically_high', 'critically_low', 'borderline', 'inconclusive_repeat']);
export type ResultFlag = z.infer<typeof ResultFlag>;
export const RESULT_FLAG_LABELS = {
  normal: 'Normal', abnormal: 'Abnormal', high: 'High', low: 'Low', critically_high: 'Critically high',
  critically_low: 'Critically low', borderline: 'Borderline', inconclusive_repeat: 'Inconclusive, repeat test',
} as const satisfies Record<ResultFlag, string>;
const flag = ResultFlag.optional();

export const ReportValue = z.discriminatedUnion('kind', [
  /** `range` is the row shown for this patient, kept with the value; absent when no range fits. */
  z.strictObject({ kind: z.literal('number'), key: PartKey, value: z.number(), range: ReferenceRange.optional(), flag }),
  z.strictObject({ kind: z.literal('choice'), key: PartKey, answer: text.max(120), flag }),
  z.strictObject({ kind: z.literal('text'), key: PartKey, text: text.max(4000), flag }),
  z.strictObject({ kind: z.literal('section'), key: PartKey, text: text.max(20000) }),
  z.strictObject({
    kind: z.literal('culture'), key: PartKey, growth: z.enum(['no_growth', 'growth']), flag,
    organisms: z.array(z.strictObject({
      name: text.max(200), count: text.max(120).optional(),
      susceptibility: z.array(z.strictObject({ antibiotic: text.max(120), result: z.enum(['S', 'I', 'R']) })).max(80).default([]),
    })).max(10).default([]),
  }).refine((v) => (v.growth === 'growth') === (v.organisms.length > 0), 'Name each organism grown, or record no growth'),
  z.strictObject({ kind: z.literal('images'), key: PartKey, files: z.array(DocumentFile).min(1).max(12) }),
]);
export type ReportValue = z.infer<typeof ReportValue>;

/** Whole years always; months and days only when a date of birth is known. */
export const LabAge = z.strictObject({ years: z.number().int().nonnegative().max(150), months: z.number().int().nonnegative().optional(), days: z.number().int().nonnegative().optional() });
export const LabPatientFacts = z.strictObject({ sex: Sex.optional(), age: LabAge.optional() });
export type LabPatientFacts = z.infer<typeof LabPatientFacts>;

export const LabReportItem = z.strictObject({
  test: text, orderItemId: text.optional(),
  /** Absent for a test with no template: one free-text `result` value. */
  template: z.strictObject({ id: ref, revision }).optional(),
  values: z.array(ReportValue).min(1).max(80),
  comment: text.max(4000).optional(),
});
export type LabReportItem = z.infer<typeof LabReportItem>;

/**
 * The structured form of a `lab_results` entry, one item per result row. It
 * sits beside the entry's values, which keep a plain summary line per test, so
 * devices that predate templates still read every result.
 */
export const LabReport = z.strictObject({ patient: LabPatientFacts, items: z.array(LabReportItem).min(1).max(50) });
export type LabReport = z.infer<typeof LabReport>;

const wholeMonths = (birth: string, on: string) => {
  const [year, month, day] = birth.slice(0, 10).split('-').map(Number), [endYear, endMonth, endDay] = on.slice(0, 10).split('-').map(Number);
  return (endYear - year) * 12 + endMonth - month - Number(endDay < day);
};
const wholeDays = (birth: string, on: string) => Math.floor((Date.parse(`${on.slice(0, 10)}T00:00:00Z`) - Date.parse(`${birth.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

/** The patient's sex and age on the day a result is published (`on`). Unknown facts are left out. */
export const labPatientFacts = (patient: { sex?: Sex; dateOfBirth?: string; ageYears?: number; ageObservedOn?: string; createdOn: string }, on: string): LabPatientFacts => {
  const years = patientAge(patient, on.slice(0, 10));
  const age = years === undefined ? undefined : patient.dateOfBirth
    ? { years, months: Math.max(0, wholeMonths(patient.dateOfBirth, on)), days: Math.max(0, wholeDays(patient.dateOfBirth, on)) } : { years };
  return { ...(patient.sex ? { sex: patient.sex } : {}), ...(age ? { age } : {}) };
};

const ageIn = (facts: LabPatientFacts, unit: AgeUnit) => facts.age?.[unit];
// A row never matches on a fact nobody recorded: an unknown age is not "an adult".
const fits = (range: ReferenceRange, facts: LabPatientFacts) => {
  if (range.sex && range.sex !== facts.sex) return false;
  if (range.ageFrom) { const age = ageIn(facts, range.ageFrom.unit); if (age === undefined || age < range.ageFrom.value) return false; }
  if (range.ageTo) { const age = ageIn(facts, range.ageTo.unit); if (age === undefined || age >= range.ageTo.value) return false; }
  return true;
};
/** The one range for this patient; none when a fact is missing, nothing fits, or more than one would. */
export const rangeFor = (part: Pick<NumberPart, 'ranges'>, facts: LabPatientFacts): ReferenceRange | undefined => {
  const matching = part.ranges.filter((range) => fits(range, facts));
  return matching.length === 1 ? matching[0] : undefined;
};

const sameBound = (a?: AgeBound, b?: AgeBound) => a?.value === b?.value && a?.unit === b?.unit;
const sameRange = (a?: ReferenceRange, b?: ReferenceRange) => !a || !b ? a === b
  : a.sex === b.sex && a.low === b.low && a.high === b.high && sameBound(a.ageFrom, b.ageFrom) && sameBound(a.ageTo, b.ageTo);
const sameFacts = (a: LabPatientFacts, b: LabPatientFacts) => a.sex === b.sex && a.age?.years === b.age?.years && a.age?.months === b.age?.months && a.age?.days === b.age?.days;

export const formatRange = (range: Pick<ReferenceRange, 'low' | 'high'>): string =>
  range.low !== undefined && range.high !== undefined ? `${range.low}–${range.high}` : range.high !== undefined ? `Up to ${range.high}` : `${range.low} and above`;

const flagged = (summary: string, value: ReportValue) => 'flag' in value && value.flag ? `${summary} (${RESULT_FLAG_LABELS[value.flag]})` : summary;
const valueSummary = (part: ResultPart, value: ReportValue): string => {
  if (part.kind === 'number' && value.kind === 'number') return flagged(`${part.label} ${value.value.toFixed(part.decimals)}${part.unit ? ` ${part.unit}` : ''}`, value);
  if (value.kind === 'choice') return flagged(`${part.label}: ${value.answer}`, value);
  if (value.kind === 'text') return flagged(part === TEXT_RESULT_PART ? value.text : `${part.label}: ${value.text}`, value);
  if (value.kind === 'section') return `${part.label}: ${value.text}`;
  if (value.kind === 'culture') return flagged(`${part.label}: ${value.growth === 'no_growth' ? 'No growth' : value.organisms.map((o) => o.count ? `${o.name} (${o.count})` : o.name).join(', ')}`, value);
  if (value.kind === 'images') return `${part.label}: ${value.files.length} ${value.files.length === 1 ? 'file' : 'files'}`;
  return part.label;
};
/** The plain line kept in the entry's values, in template order. Device and server build it the same way. */
export const labItemSummary = (item: Pick<LabReportItem, 'values' | 'comment'>, parts: readonly ResultPart[]): string =>
  [...parts.flatMap((part) => item.values.filter((value) => value.key === part.key).map((value) => valueSummary(part, value))), ...(item.comment ? [`Comment: ${item.comment}`] : [])].join('; ');

const valueIssue = (values: readonly ReportValue[], parts: readonly ResultPart[], facts: LabPatientFacts): string | undefined => {
  const keys = values.map((value) => value.key);
  if (new Set(keys).size !== keys.length) return 'Each part can be recorded once';
  for (const value of values) {
    const part = parts.find((p) => p.key === value.key);
    if (!part || part.kind !== value.kind) return 'A recorded value is not part of this template';
    if (part.kind === 'number' && value.kind === 'number') {
      if (Number(value.value.toFixed(part.decimals)) !== value.value) return `${part.label}: use ${part.decimals} decimal places at most`;
      if (!sameRange(value.range, rangeFor(part, facts))) return `${part.label}: the normal range shown does not match this patient`;
    }
    if (part.kind === 'choice' && value.kind === 'choice' && !part.answers.includes(value.answer)) return `${part.label}: choose one of the template's answers`;
    if (part.kind === 'culture' && value.kind === 'culture' && value.organisms.some((o) => o.susceptibility.some((s) => !part.antibiotics.includes(s.antibiotic)) || new Set(o.susceptibility.map((s) => s.antibiotic)).size !== o.susceptibility.length))
      return `${part.label}: record each listed antibiotic once per organism`;
    if (part.kind === 'images' && value.kind === 'images' && value.files.length > part.maxFiles) return `${part.label}: attach up to ${part.maxFiles} files`;
  }
  const missing = parts.find((part) => part.required && !keys.includes(part.key));
  return missing ? `${missing.label} is required` : undefined;
};

export type LabReportContext = {
  /** The patient's facts on the publishing day, from `labPatientFacts`. */
  facts: LabPatientFacts;
  /** A saved template revision of this facility. */
  template: (id: string, revision: number) => ResultTemplate | undefined;
  /** The catalogue test an ordered item names; undefined for an unlisted request. */
  serviceDefinitionFor: (orderItemId: string | undefined) => string | undefined;
};

/**
 * Device and server run the same checks before a structured result is kept: it
 * matches the entry's result rows, uses a template revision set up for that
 * test, records only the template's parts, shows the range for this patient,
 * and its summary line is the one these values produce.
 */
export const labReportIssues = (results: readonly { test: string; result: string; orderItemId?: string }[], report: LabReport, context: LabReportContext): string[] => {
  if (!sameFacts(report.patient, context.facts)) return ['The patient’s recorded sex or age has changed. Reopen the result before publishing'];
  if (report.items.length !== results.length || report.items.some((item, i) => item.test !== results[i].test || item.orderItemId !== results[i].orderItemId)) return ['Each structured result must match a recorded test'];
  for (const [i, item] of report.items.entries()) {
    const template = item.template ? context.template(item.template.id, item.template.revision) : undefined;
    if (item.template && !template) return [`${item.test}: this result template version is not available`];
    if (template && (template.status !== 'active' || !template.serviceDefinitionIds.includes(context.serviceDefinitionFor(item.orderItemId) ?? ''))) return [`${item.test}: this result template is not in use for this test`];
    const parts = template?.parts ?? [TEXT_RESULT_PART];
    const issue = valueIssue(item.values, parts, context.facts);
    if (issue) return [`${item.test}: ${issue}`];
    if (results[i].result !== labItemSummary(item, parts)) return [`${item.test}: the result summary does not match the structured result`];
  }
  return [];
};

/** A scientist flagged a value as critical; the requesting clinician's alert says so. */
export const hasCriticalFlag = (report: LabReport | undefined): boolean =>
  Boolean(report?.items.some((item) => item.values.some((value) => 'flag' in value && (value.flag === 'critically_high' || value.flag === 'critically_low'))));
