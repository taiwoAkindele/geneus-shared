/**
 * Where a patient receives bills and receipts.
 *
 * Bills and receipts are transactional messages about care the patient is receiving, so they go to the contact
 * details on file without an opt-in. The patient can stop a channel from any message or document page (and,
 * later, the patient app); only the patient can start it again. Staff may record a stop the patient asks for.
 *
 * Kept apart from `Patient` so older clients, which rewrite the whole patient record, can never drop it, and so
 * each change is kept: a change is a new record that `replaces` the previous one.
 */
import { z } from 'zod';
import { baseEnvelope, patientId } from './common.ts';
import { emailAddress } from './api.ts';

/** Who made the change: staff on the patient's behalf (uploaded from a device) or the patient (written by the server). */
export const ContactChangeSource = z.enum(['staff', 'patient']);
export type ContactChangeSource = z.infer<typeof ContactChangeSource>;

export const PatientContact = baseEnvelope.extend({
  type: z.literal('patient_contact'),
  patientId,
  /** Optional; the phone number stays on the patient record. */
  email: emailAddress.pipe(z.string().max(200)).optional(),
  smsStopped: z.boolean(),
  emailStopped: z.boolean(),
  source: ContactChangeSource,
  replaces: z.string().min(1).optional(),
});
export type PatientContact = z.infer<typeof PatientContact>;

/**
 * The patient's current contact record: the newest one no other record replaces. Records for other patients
 * are ignored. Undefined when nothing has been recorded.
 */
export const currentPatientContact = (records: readonly PatientContact[], patient: string): PatientContact | undefined => {
  const mine = records.filter((r) => r.patientId === patient);
  const replaced = new Set(mine.map((r) => r.replaces).filter(Boolean));
  return mine.filter((r) => !replaced.has(r.id)).sort((a, b) => b.createdOn.localeCompare(a.createdOn) || b.id.localeCompare(a.id))[0];
};

export type MessageChannel = 'sms' | 'email';
/** The channels bills and receipts can go to: those with contact details that the patient hasn't stopped. */
export const availableChannels = (contact: PatientContact | undefined, phone: string | undefined): MessageChannel[] => {
  const channels: MessageChannel[] = [];
  if (phone?.trim() && !contact?.smsStopped) channels.push('sms');
  if (contact?.email && !contact.emailStopped) channels.push('email');
  return channels;
};

/**
 * Why a change isn't allowed, or undefined when it is. `previous` is the record it replaces (undefined for the first).
 * - Only the patient can start a channel they stopped.
 * - A patient's change only stops or starts channels; contact details are changed by staff.
 */
export const contactChangeProblem = (previous: PatientContact | undefined, next: PatientContact): string | undefined => {
  if (previous && previous.patientId !== next.patientId) return 'This change is for a different patient';
  if (next.source === 'staff') {
    if (previous?.smsStopped && !next.smsStopped) return 'The patient stopped SMS. Only the patient can start it again';
    if (previous?.emailStopped && !next.emailStopped) return 'The patient stopped email. Only the patient can start it again';
  }
  if (next.source === 'patient' && previous?.email !== next.email) return "A patient's change can't alter contact details";
  return undefined;
};
