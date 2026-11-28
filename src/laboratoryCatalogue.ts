import { z } from 'zod';

const catalogueText = z.string().trim().min(1).max(200);

export const LaboratoryPricingCategory = z.enum(['billable', 'non_billable']);
export const SpecimenRequirement = z.enum(['any', 'all']);

export const LABORATORY_SPECIMEN_TYPES = [
  'Whole blood',
  'EDTA whole blood',
  'Serum',
  'Plasma',
  'Urine',
  'Stool',
  'Sputum',
  'Throat swab',
  'Wound swab',
  'Cerebrospinal fluid (CSF)',
  'Tissue',
] as const;

export const specimenTypeKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export const LaboratoryCatalogueDetails = z
  .strictObject({
    pricingCategory: LaboratoryPricingCategory,
    specimenTypes: z.array(catalogueText).min(1).max(20),
    specimenRequirement: SpecimenRequirement.optional(),
  })
  .refine(
    ({ specimenTypes }) =>
      new Set(specimenTypes.map(specimenTypeKey)).size === specimenTypes.length,
    { path: ['specimenTypes'], message: 'Each specimen type must be different' },
  )
  .refine(
    ({ specimenTypes, specimenRequirement }) =>
      specimenTypes.length > 1 === Boolean(specimenRequirement),
    {
      path: ['specimenRequirement'],
      message: 'Choose a requirement when using multiple specimen types',
    },
  );

export type LaboratoryCatalogueDetails = z.infer<typeof LaboratoryCatalogueDetails>;

export const laboratorySpecimenLabel = (details: LaboratoryCatalogueDetails): string => {
  if (details.specimenRequirement === 'all') {
    return `${details.specimenTypes.join(' + ')} (all required)`;
  }

  return details.specimenTypes.join(' or ');
};

export const LaboratoryTestInput = z.strictObject({
  name: catalogueText,
  department: catalogueText,
  aliases: z.array(catalogueText).max(50).default([]),
  catalogue: LaboratoryCatalogueDetails,
  standardKey: catalogueText.optional(),
  resultTemplateId: catalogueText.optional(),
});

export type LaboratoryTestInput = z.infer<typeof LaboratoryTestInput>;

export const LaboratoryPriceInput = z.strictObject({
  definitionId: catalogueText,
  revision: z.number().int().positive(),
  amountMinor: z.number().int().min(0).max(2_147_483_647),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export type LaboratoryPriceInput = z.infer<typeof LaboratoryPriceInput>;
