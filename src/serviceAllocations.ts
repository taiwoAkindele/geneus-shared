import { z } from 'zod';
import { baseEnvelope, isoDateTime } from './common.ts';

/** Financial association only. Does not attest clinical completion or receipt of money. */
export const ServiceChargeAllocation = baseEnvelope
  .extend({
    type: z.literal('service_charge_allocation'),
    patientId: z.string().min(1),
    chargeId: z.string().min(1),
    sourceKind: z.enum(['laboratory', 'pharmacy']),
    sourceEntryId: z.string().min(1),
    sourceItemId: z.string().min(1),
    action: z.enum(['allocate', 'release']),
    quantity: z
      .number()
      .min(0.000001)
      .max(1000000)
      .refine(
        (q) => Math.abs(q * 1e6 - Math.round(q * 1e6)) <= Number.EPSILON * Math.max(1, q * 1e6) * 2,
        'Use at most six decimal places for an associated quantity',
      )
      .transform((q) => Math.round(q * 1e6) / 1e6),
    unit: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(3).max(1000),
    reversesId: z.string().min(1).optional(),
    returnEntryId: z.string().min(1).optional(),
    /** A credit extinguishes purchased quantity; a correction release only frees it. */
    creditReturnedUnits: z.boolean().default(false),
    /** Only server acceptance makes the relationship authoritative. */
    acceptedOn: isoDateTime.optional(),
    creditMinor: z.number().int().nonnegative().optional(),
  })
  .superRefine((a, c) => {
    if (a.action === 'allocate' && (a.reversesId || a.returnEntryId || a.creditReturnedUnits)) {
      c.addIssue({ code: 'custom', message: 'An allocation cannot release or credit quantity' });
    }
    if (a.action === 'release' && !a.reversesId) {
      c.addIssue({ code: 'custom', message: 'A release names the exact accepted allocation' });
    }
    if (a.creditReturnedUnits && !a.returnEntryId) {
      c.addIssue({ code: 'custom', message: 'A credit requires an actual returned supply' });
    }
  });
export type ServiceChargeAllocation = z.infer<typeof ServiceChargeAllocation>;
/** Integer millionths avoid a floating-point tolerance permitting capacity overdrafts. */
export const serviceQuantityUnits = (quantity: number) => Math.round(quantity * 1e6);
export const acceptedServiceAllocations = (records: readonly ServiceChargeAllocation[]) =>
  records.filter((a) => Boolean(a.acceptedOn));
export const allocatedQuantity = (
  records: readonly ServiceChargeAllocation[],
  filter: (a: ServiceChargeAllocation) => boolean,
) =>
  acceptedServiceAllocations(records)
    .filter(filter)
    .reduce((n, a) => n + (a.action === 'allocate' ? a.quantity : -a.quantity), 0);
export const creditedQuantity = (records: readonly ServiceChargeAllocation[], chargeId: string) =>
  acceptedServiceAllocations(records)
    .filter((a) => a.chargeId === chargeId && a.action === 'release' && a.creditReturnedUnits)
    .reduce((n, a) => n + a.quantity, 0);
