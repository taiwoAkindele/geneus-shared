/**
 * Bills and receipts a patient can open from a link (docs/PATIENT-BILL-DELIVERY-PLAN-2026-11-21.md, step 2).
 *
 * A bill is presentation, not a record: the charges one source raised for a patient in one currency. The app,
 * the server's public pages and the messages all name it the same way, so the rules live here.
 */
import { z } from 'zod';
import type { Charge } from './documents.ts';

/** Groups charges by explicit source identity, never by coincident dates or amounts. */
/** Charges group into one bill by explicit bill, else visit, else appointment, else alone. */
const billGroup = (c: Pick<Charge, 'id' | 'billId' | 'encounterId' | 'appointmentId'>): string => {
  if (c.billId) {
    return `bill:${c.billId}`;
  }

  if (c.encounterId) {
    return `visit:${c.encounterId}`;
  }

  if (c.appointmentId) {
    return `appointment:${c.appointmentId}`;
  }

  return `charge:${c.id}`;
};

export const billKey = (
  c: Pick<Charge, 'id' | 'patientId' | 'currency' | 'billId' | 'encounterId' | 'appointmentId'>,
): string => `${c.patientId}|${c.currency}|${billGroup(c)}`;

/** The bill's short reference, e.g. B-63AF2E1C9D04, as printed on the invoice and in messages. */
export const billReference = (key: string): string =>
  `B-${key
    .split('|')
    .slice(-1)[0]
    .replace(/^[^:]+:/, '')
    .slice(-12)
    .toUpperCase()}`;

/** The patient and currency a bill key names (the source part may itself contain separators). */
export const billKeyParts = (
  key: string,
): { patientId: string; currency: string; source: string } | undefined => {
  const [patientId, currency, ...rest] = key.split('|');

  return patientId && /^[A-Z]{3}$/.test(currency ?? '') && rest.length
    ? { patientId, currency, source: rest.join('|') }
    : undefined;
};

export const DocumentKind = z.enum(['bill', 'receipt']);

export type DocumentKind = z.infer<typeof DocumentKind>;

/** Bill links last 30 days; receipt links a year. */
export const DOCUMENT_LINK_DAYS: Record<DocumentKind, number> = { bill: 30, receipt: 365 };

const billKeyText = z
  .string()
  .min(5)
  .max(300)
  .refine((key) => Boolean(billKeyParts(key)), 'Not a bill');

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

/* ------------------------------------------------------------------ */
/* What the patient's page shows (served by the web app at /p/b/:token  */
/* and /p/r/:token, from the server's public document API)             */
/* ------------------------------------------------------------------ */

export type DocumentHospital = {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  timeZone: string;
};

export type DocumentPatient = { name: string; patientId: string; phone?: string };

export type BillLine = {
  description: string;
  category: string;
  quantity: number;
  unitMinor: number;
  amountMinor: number;
  exempt: boolean;
};

export type BillStatus = 'Unpaid' | 'Part paid' | 'Paid' | 'Awaiting insurance';

/** A bill as the patient sees it, built by the server from accepted records with the app's balance rules. */
export type BillView = {
  key: string;
  reference: string;
  currency: string;
  issuedOn: string;
  status: BillStatus;
  hospital: DocumentHospital;
  patient: DocumentPatient;
  lines: BillLine[];
  totals: {
    subtotalMinor: number;
    exemptMinor: number;
    reducedMinor: number;
    /** What insurance has been decided to pay. */
    insuranceMinor: number;
    /** Waiting for the insurer's decision: never part of the balance due. */
    undecidedMinor: number;
    totalMinor: number;
    paidMinor: number;
    dueMinor: number;
    creditMinor: number;
  };
  /** Whether the patient can pay this bill online now (a live checkout provider is connected and something is due). */
  payable: boolean;
};

export type ReceiptView = {
  paymentId: string;
  number: string;
  currency: string;
  receivedOn: string;
  method: string;
  reference?: string;
  reversal: boolean;
  receivedBy: string;
  hospital: DocumentHospital;
  patient: DocumentPatient;
  applied: { bill: string; item: string; amountMinor: number }[];
  amountMinor: number;
  stillDue: { bill: string; dueMinor: number }[];
};

/** GET /public/documents/:kind/:token */
export type PublicDocument =
  { kind: 'bill'; bill: BillView } | { kind: 'receipt'; receipt: ReceiptView };

/** The patient's own message choices (GET/POST /public/documents/:kind/:token/messages). Contact details are masked. */
export type PublicMessageChoices = {
  hospital: string;
  sms?: { to: string; stopped: boolean };
  email?: { to: string; stopped: boolean };
  changed?: boolean;
};

export const PublicMessageChoice = z.strictObject({
  channel: z.enum(['sms', 'email']),
  choice: z.enum(['stop', 'start']),
});

export type PublicMessageChoice = z.infer<typeof PublicMessageChoice>;

/* ------------------------------------------------------------------ */
/* Paying a bill online (step 6)                                        */
/* ------------------------------------------------------------------ */

/** POST /public/documents/bill/:token/pay: where to send the patient to pay what is due now. */
export type CheckoutStart = {
  checkoutUrl: string;
  reference: string;
  amountMinor: number;
  currency: string;
};

/**
 * GET /public/checkout/:reference: the outcome, confirmed with the provider by the server (never trusted from
 * the redirect alone). `paid` means the money was received and applied; any amount above what was due waits
 * for staff and `heldMinor` says how much.
 */
export type CheckoutState = {
  status: 'pending' | 'paid' | 'failed' | 'expired';
  amountMinor: number;
  currency: string;
  heldMinor?: number;
  billPath?: string;
};
