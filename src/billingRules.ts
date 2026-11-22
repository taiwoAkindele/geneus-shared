import { z } from 'zod';
import { Sex } from './common.ts';
import { VisitType } from './facilityTypes.ts';
const text = z.string().trim().min(1);
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
    (rule) =>
      rule.ageUnderYears === undefined ||
      rule.ageFromYears === undefined ||
      rule.ageFromYears < rule.ageUnderYears,
    { message: 'No patient can be both that old and that young', path: ['ageFromYears'] },
  );
export type ExemptionRule = z.infer<typeof ExemptionRule>;
