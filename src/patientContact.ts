/**
 * How a patient wants to receive bills and receipts.
 *
 * Kept apart from `Patient` so that older clients, which rewrite the whole patient record, can never drop it,
 * and so each consent change is kept (NDPA): a change is a new record that `replaces` the previous one.
 * A channel the patient hasn't agreed to is neither offered to staff nor used automatically.
 */
import { z } from 'zod';
import { baseEnvelope, patientId } from './common.ts';
import { emailAddress } from './api.ts';

export const PatientContact = baseEnvelope.extend({
  type: z.literal('patient_contact'),
  patientId,
  /** Optional; the phone number stays on the patient record. */
  email: emailAddress.pipe(z.string().max(200)).optional(),
  smsConsent: z.boolean(),
  emailConsent: z.boolean(),
  replaces: z.string().min(1).optional(),
}).refine((contact) => !contact.emailConsent || Boolean(contact.email), { message: 'Add an email address before agreeing to email', path: ['email'] });
export type PatientContact = z.infer<typeof PatientContact>;

/**
 * The patient's current contact choices: the newest record no other record replaces. Records for other
 * patients are ignored. Returns undefined when nothing has been recorded (no channel is agreed).
 */
export const currentPatientContact = (records: readonly PatientContact[], patient: string): PatientContact | undefined => {
  const mine = records.filter((r) => r.patientId === patient);
  const replaced = new Set(mine.map((r) => r.replaces).filter(Boolean));
  return mine.filter((r) => !replaced.has(r.id)).sort((a, b) => b.createdOn.localeCompare(a.createdOn) || b.id.localeCompare(a.id))[0];
};

export type MessageChannel = 'sms' | 'email';
/** The channels this patient has agreed to, given their contact choices and phone number. */
export const agreedChannels = (contact: PatientContact | undefined, phone: string | undefined): MessageChannel[] => {
  const channels: MessageChannel[] = [];
  if (contact?.smsConsent && phone?.trim()) channels.push('sms');
  if (contact?.emailConsent && contact.email) channels.push('email');
  return channels;
};
