/**
 * Bills and receipts a patient can open from a link (docs/PATIENT-BILL-DELIVERY-PLAN-2026-11-21.md, step 2).
 *
 * A bill is presentation, not a record: the charges one source raised for a patient in one currency. The app,
 * the server's public pages and the messages all name it the same way, so the rules live here.
 */
import { z } from 'zod';
import type { Charge } from './documents.ts';

/** Groups charges by explicit source identity, never by coincident dates or amounts. */
export const billKey = (c: Pick<Charge, 'id' | 'patientId' | 'currency' | 'billId' | 'encounterId' | 'appointmentId'>): string =>
  `${c.patientId}|${c.currency}|${c.billId ? `bill:${c.billId}` : c.encounterId ? `visit:${c.encounterId}` : c.appointmentId ? `appointment:${c.appointmentId}` : `charge:${c.id}`}`;

/** The bill's short reference, e.g. B-63AF2E1C9D04, as printed on the invoice and in messages. */
export const billReference = (key: string): string => `B-${key.split('|').slice(-1)[0].replace(/^[^:]+:/, '').slice(-12).toUpperCase()}`;

/** The patient and currency a bill key names (the source part may itself contain separators). */
export const billKeyParts = (key: string): { patientId: string; currency: string; source: string } | undefined => {
  const [patientId, currency, ...rest] = key.split('|');
  return patientId && /^[A-Z]{3}$/.test(currency ?? '') && rest.length ? { patientId, currency, source: rest.join('|') } : undefined;
};

export const DocumentKind = z.enum(['bill', 'receipt']);
export type DocumentKind = z.infer<typeof DocumentKind>;

/** Bill links last 30 days; receipt links a year. */
export const DOCUMENT_LINK_DAYS: Record<DocumentKind, number> = { bill: 30, receipt: 365 };

const billKeyText = z.string().min(5).max(300).refine((key) => Boolean(billKeyParts(key)), 'Not a bill');

/** Staff ask for a patient link to a bill or a receipt. */
export const DocumentLinkRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bill'), billKey: billKeyText }),
  z.strictObject({ kind: z.literal('receipt'), paymentId: z.string().min(1).max(200) }),
]);
export type DocumentLinkRequest = z.infer<typeof DocumentLinkRequest>;
export type DocumentLinkResponse = { url: string; expiresOn: string };

/** Staff stop every open link to a bill or a receipt (e.g. one was forwarded to the wrong person). */
export const DocumentLinkStop = DocumentLinkRequest;
export type DocumentLinkStopResponse = { stopped: number };
