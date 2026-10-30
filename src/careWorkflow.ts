import { z } from 'zod';
import { isoDate, isoDateTime } from './common.ts';
import type { EncounterEntry } from './documents.ts';

const text = z.string().trim().min(1);
export const CLINICAL_WORKFLOW_VERSION = 1 as const;
export const InvestigationItem = z.strictObject({
  id: text, name: text, serviceDefinitionId: text.optional(), offeringId: text.optional(),
  feeItemId: text.optional(), feePriceVersion: text.optional(), catalogueRevision: z.number().int().positive().optional(), definitionRevision: z.number().int().positive().optional(),
  specimen: text.optional(), priority: z.enum(['routine', 'urgent']).default('routine'),
  priceMinor: z.number().int().nonnegative().optional(), currency: text.optional(),
  custom: z.boolean().optional(),
}).refine((v) => v.custom || (v.serviceDefinitionId && v.offeringId), 'Select a catalogue investigation or identify a custom request')
  .refine((v) => (v.priceMinor === undefined) === (v.currency === undefined), 'Price and currency must be recorded together');
export type InvestigationItem = z.infer<typeof InvestigationItem>;
export const InvestigationReview = z.strictObject({
  decision: z.enum(['none_required', 'ordered']), reason: text.optional(), orderEntryId: text.optional(),
}).refine((v) => v.decision === 'ordered' ? Boolean(v.orderEntryId) : !v.orderEntryId, 'An ordered decision must reference its lab order');
export const Disposition = z.strictObject({
  kind: z.enum(['home_care', 'observation', 'referral', 'admission']),
  note: text, responsibleService: text.optional(), reassessOn: isoDateTime.optional(),
  toFacilityId: text.optional(), referralId: text.optional(), previousEntryId: text.optional(),
  followUpOn: isoDate.optional(), appointmentId: text.optional(),
}).superRefine((v, ctx) => {
  if (['observation', 'admission'].includes(v.kind) && !v.responsibleService) ctx.addIssue({ code: 'custom', message: 'Choose the responsible receiving service', path: ['responsibleService'] });
  if (v.kind === 'observation' && !v.reassessOn) ctx.addIssue({ code: 'custom', message: 'Record when reassessment is due', path: ['reassessOn'] });
  if (v.kind === 'referral' && (!v.toFacilityId || !v.referralId)) ctx.addIssue({ code: 'custom', message: 'A referral disposition needs a destination and linked referral', path: ['toFacilityId'] });
});
export type Disposition = z.infer<typeof Disposition>;
export const NEW_CARE_STEPS = ['investigation_review', 'result_review', 'prescription', 'injection_order', 'disposition'] as const;
export const closesEncounter = (entry: { step: string; values: Record<string, unknown> }): boolean =>
  entry.step === 'admission' || entry.step === 'follow_up' || (entry.step === 'disposition' && entry.values.kind !== 'observation');
export const POST_CONSULTATION_STEPS = ['lab_results', 'result_review', 'dispense', 'injection', 'amendment'] as const;
export const dispositionHeads = (entries: readonly EncounterEntry[]) => {
  const dispositions = entries.filter((e) => e.step === 'disposition');
  const replaced = new Set(dispositions.map((e) => e.values.previousEntryId));
  return dispositions.filter((e) => !replaced.has(e.id));
};

/** Local repositories and the server run the same cross-entry rules. */
export const careEntryIssues = (entry: Pick<EncounterEntry, 'step' | 'values'> & { workflowVersion?: 1 }, prior: readonly EncounterEntry[]): string[] => {
  const latest = (step: string) => [...prior].reverse().find((p) => p.step === step);
  if (entry.workflowVersion === 1 && ['admission', 'follow_up'].includes(entry.step)) return ['Record an explicit disposition for this consultation'];
  if (entry.workflowVersion === 1 && entry.step === 'diagnosis' && ((entry.values.prescription as unknown[] | undefined)?.length || entry.values.giveInjection || entry.values.admit)) return ['Record medication, injection orders and disposition independently of diagnosis'];
  if (entry.step === 'disposition') {
    if (!latest('diagnosis') || !latest('investigation_review')) return ['Sign the assessment and investigation decision before recording disposition'];
    const heads = dispositionHeads(prior);
    if (heads.length > 1) return ['Competing dispositions need reconciliation before another decision'];
    const previous = heads[0];
    if ((previous?.id ?? undefined) !== entry.values.previousEntryId) return ['Disposition changed. Review the latest decision before continuing'];
    if (previous && previous.values.kind !== 'observation') return ['This disposition is complete; add an attributed amendment'];
    if (entry.values.kind === 'referral' && !entry.values.referralId) return ['Create the linked referral before completing disposition'];
  }
  if (entry.step === 'investigation_review') {
    if (entry.values.decision === 'ordered' && !prior.some((p) => p.id === entry.values.orderEntryId && p.step === 'lab_order')) return ['The testing decision must reference this encounter’s laboratory order'];
    if (entry.values.decision === 'none_required' && latest('lab_order')) return ['An investigation order already exists; cancel it explicitly rather than recording none required'];
  }
  if (entry.step === 'injection' && latest('injection_order')?.values.required === false) return ['No injection was ordered'];
  if (entry.workflowVersion === 1 && entry.step === 'injection' && !latest('injection_order')?.values.required) return ['Sign an injection order before recording administration'];
  if (entry.step === 'result_review') {
    const ids = entry.values.resultEntryIds as string[];
    const reviewed = prior.filter((p) => p.step === 'result_review').flatMap((p) => p.values.resultEntryIds as string[]);
    if (ids.some((id) => !prior.some((p) => p.id === id && p.step === 'lab_results') || reviewed.includes(id))) return ['Review only existing results that have not already been acknowledged'];
  }
  if (entry.step === 'dispense') {
    const medication = latest('prescription') ?? latest('diagnosis');
    const prescription = medication?.values.prescription as { drug: string }[] | undefined;
    const lines = entry.values.lines as { drug: string }[];
    if (!prescription?.length || lines.length !== prescription.length || lines.some((line, i) => line.drug !== prescription[i].drug)) return ['Dispensing must identify the signed prescription lines'];
  }
  if (entry.step === 'lab_results' && (entry.workflowVersion === 1 || latest('lab_order'))) {
    const order = latest('lab_order');
    if (!order) return ['A result must reference an existing laboratory order'];
    const items = order.values.items as InvestigationItem[] | undefined;
    const results = entry.values.results as { test: string; result: string; orderItemId?: string }[];
    const priorResults = prior.filter((p) => p.step === 'lab_results').flatMap((p) => p.values.results as { test: string; orderItemId?: string }[]);
    if (results.some((r) => items ? !items.some((i) => i.id === r.orderItemId && i.name === r.test) : !(order.values.tests as string[]).includes(r.test))) return ['Each result must identify a requested investigation'];
    if (new Set(results.map((r) => r.orderItemId ?? r.test)).size !== results.length || results.some((r) => priorResults.some((p) => (p.orderItemId ?? p.test) === (r.orderItemId ?? r.test)))) return ['This investigation already has a result; correct it through an amendment'];
  }
  return [];
};

export const OrganizationCreate = z.strictObject({ actorStaffId: text, name: text.max(200) });
export const OrganizationActor = z.strictObject({ actorStaffId: text });
export const OrganizationJoin = OrganizationActor.extend({ code: text });
export const StaffProvisionRequest = OrganizationActor.extend({ staffId: text, toFacilityId: text });
export const StaffProvisionAccept = OrganizationActor.extend({ role: z.enum(['doctor', 'nurse', 'chew', 'records_officer', 'cashier', 'laboratory_staff', 'pharmacy_staff']), permission: z.enum(['read_only', 'read_write']) });
export type OrganizationSummary = { id: string; name: string; facilities: { id: string; name: string }[] };
export type ProvisionRequestSummary = { id: string; fromFacilityId: string; fullName: string; status: string };
