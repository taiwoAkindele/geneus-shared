import { z } from 'zod';
const ref = z.string().trim().min(1).max(200);
const quantity = z.number().finite().positive().max(1_000_000);
const minor = z.number().int().nonnegative().safe();
/** One immutable supply, return, or attributed decision for an exact prescription line. */
export const DispensingDetails = z.strictObject({
  prescriptionEntryId: ref, lineId: ref, previousEntryId: ref.optional(),
  action: z.enum(['supply', 'return', 'note', 'price']), complete: z.boolean(),
  quantity: quantity.optional(), unit: ref.optional(),
  source: z.enum(['stock', 'untracked', 'outside']).optional(), stockItemId: ref.optional(),
  billing: z.enum(['charge', 'unpriced', 'outside']).optional(),
  feeItemId: ref.optional(), feePriceVersion: ref.optional(), unitPriceMinor: minor.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), chargedMinor: minor.optional(),
  returnOf: ref.optional(), restock: z.boolean().optional(), creditMinor: minor.optional(),
  priceFor: ref.optional(),
  reason: z.string().trim().min(3).max(2000).optional(),
}).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.action === 'supply') {
    if (!v.quantity || !v.unit || !v.source || !v.billing) issue('Record the quantity, unit, source and billing decision');
    if ((v.source === 'stock') !== Boolean(v.stockItemId)) issue('Choose the stock item actually supplied');
    if (v.source === 'outside' && v.billing !== 'outside') issue('Outside supplies do not create a hospital medicine bill');
    if (v.source !== 'outside' && v.billing === 'outside') issue('A hospital supply needs a price or a billing follow-up reason');
    if (v.billing === 'charge') {
      if (!v.feeItemId || v.unitPriceMinor === undefined || !v.currency || v.chargedMinor === undefined) issue('Keep the selected price with this supply');
    } else if (v.feeItemId || v.unitPriceMinor !== undefined || v.currency || v.chargedMinor !== undefined) issue('Only a priced supply can carry a medicine charge');
    if (v.billing === 'unpriced' && !v.reason) issue('Explain why this supply needs billing follow-up');
    if (v.returnOf || v.restock !== undefined || v.creditMinor !== undefined || v.priceFor) issue('A supply cannot contain return or later billing details');
  } else if (v.action === 'return') {
    if (!v.quantity || !v.unit || !v.returnOf || !v.reason || v.restock === undefined || v.creditMinor === undefined) issue('Record the return quantity, original supply and reason');
    if (v.source || v.stockItemId || v.billing || v.feeItemId || v.unitPriceMinor !== undefined || v.currency || v.chargedMinor !== undefined || v.priceFor) issue('A return uses its original supply and price');
  } else if (v.action === 'price') {
    if (!v.priceFor || !v.quantity || !v.unit || v.billing !== 'charge' || !v.feeItemId || v.unitPriceMinor === undefined || !v.currency || v.chargedMinor === undefined) issue('Choose the unbilled supply and its configured selling price');
    if (v.source || v.stockItemId || v.returnOf || v.restock !== undefined || v.creditMinor !== undefined) issue('Billing a saved supply does not move stock again');
  } else {
    if (!v.reason) issue('Record why this medicine remains pending or is complete');
    if (v.quantity !== undefined || v.unit || v.source || v.stockItemId || v.billing || v.feeItemId || v.unitPriceMinor !== undefined || v.currency || v.chargedMinor !== undefined || v.returnOf || v.restock !== undefined || v.creditMinor !== undefined || v.priceFor) issue('A note cannot change stock or billing');
  }
});
export type DispensingDetails = z.infer<typeof DispensingDetails>;
