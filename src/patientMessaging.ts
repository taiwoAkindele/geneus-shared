/**
 * Sending bills and receipts to patients by SMS and email (docs/PATIENT-BILL-DELIVERY-PLAN-2026-11-21.md,
 * steps 3 to 5). The server sends; devices see each send as a server-written `patient_message` record, which
 * shows in the bill's or receipt's Activity. Message text and PDFs are never stored, and the recipient is masked.
 */
import { z } from 'zod';
import { baseEnvelope, isoDateTime, patientId } from './common.ts';
import { DocumentKind, DocumentLinkRequest } from './patientDocuments.ts';
import { MessageChannel } from './patientContact.ts';

export const PatientMessageStatus = z.enum(['queued', 'sent', 'delivered', 'failed']);
export type PatientMessageStatus = z.infer<typeof PatientMessageStatus>;

/** One send of a bill or receipt on one channel. Written and updated only by the server. */
export const PatientMessage = baseEnvelope.extend({
  type: z.literal('patient_message'),
  patientId,
  kind: DocumentKind,
  /** The bill key or the payment id. */
  subject: z.string().min(1).max(300),
  /** What staff and the patient call it: the bill reference (B-…) or the receipt number. */
  reference: z.string().min(1).max(100),
  channel: MessageChannel,
  /** Masked, e.g. "0803 *** 4567" or "a***@gmail.com". */
  to: z.string().min(1).max(200),
  status: PatientMessageStatus,
  /** Sent by a person (`createdBy` is them) or automatically when a payment was accepted. */
  automatic: z.boolean(),
  /** Why it failed, in words safe to show staff; never provider internals. */
  reason: z.string().max(300).optional(),
  attempts: z.number().int().min(0).max(10),
  sentOn: isoDateTime.optional(),
  deliveredOn: isoDateTime.optional(),
});
export type PatientMessage = z.infer<typeof PatientMessage>;

/** Staff send a bill or receipt to the patient on the channels chosen (only those the patient hasn't stopped). */
export const SendToPatientRequest = z
  .discriminatedUnion('kind', [
    DocumentLinkRequest.options[0].extend({ channels: z.array(MessageChannel).min(1).max(2) }),
    DocumentLinkRequest.options[1].extend({ channels: z.array(MessageChannel).min(1).max(2) }),
  ])
  .refine((r) => new Set(r.channels).size === r.channels.length, {
    message: 'Choose each channel once',
    path: ['channels'],
  });
export type SendToPatientRequest = z.infer<typeof SendToPatientRequest>;
/** One entry per channel: queued for sending, or refused with a reason (e.g. the patient stopped it). */
export type SendToPatientResponse = {
  messages: {
    channel: MessageChannel;
    to?: string;
    status: 'queued' | 'refused';
    reason?: string;
    messageId?: string;
  }[];
};
