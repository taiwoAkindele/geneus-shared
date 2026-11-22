import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IncomingTransfer,
  Payment,
  PatientMessage,
  PublicMessageChoice,
  SCHEMA_BY_TYPE,
  SendToPatientRequest,
} from '../src/index.ts';

const base = {
  facilityId: 'TEST',
  deviceId: 'device:one',
  schemaVersion: 7,
  createdBy: 'system',
  createdOn: '2026-11-22T10:00:00.000Z',
};

describe('patient messaging contract', () => {
  it('records a send with a masked recipient and a safe reason', () => {
    const message = PatientMessage.parse({
      ...base,
      id: 'patient_message:1',
      type: 'patient_message',
      patientId: 'TEST-000001-K2',
      kind: 'bill',
      subject: 'TEST-000001-K2|NGN|visit:encounter:1',
      reference: 'B-ENCOUNTER:1',
      channel: 'sms',
      to: '0803 *** 4567',
      status: 'failed',
      automatic: false,
      reason: 'The SMS provider refused this number',
      attempts: 3,
    });
    assert.equal(SCHEMA_BY_TYPE.patient_message, PatientMessage);
    assert.equal(message.status, 'failed');
    assert.throws(() => PatientMessage.parse({ ...message, channel: 'whatsapp' }));
  });
  it('sends a bill or receipt on each chosen channel once', () => {
    assert.deepEqual(
      SendToPatientRequest.parse({
        kind: 'bill',
        billKey: 'TEST-000001-K2|NGN|visit:x',
        channels: ['sms', 'email'],
      }).channels,
      ['sms', 'email'],
    );
    assert.equal(
      SendToPatientRequest.parse({ kind: 'receipt', paymentId: 'payment:1', channels: ['email'] })
        .kind,
      'receipt',
    );
    assert.throws(() =>
      SendToPatientRequest.parse({
        kind: 'bill',
        billKey: 'TEST-000001-K2|NGN|visit:x',
        channels: ['sms', 'sms'],
      }),
    );
    assert.throws(() =>
      SendToPatientRequest.parse({ kind: 'receipt', paymentId: 'payment:1', channels: [] }),
    );
  });
  it("accepts the patient's own choice", () => {
    assert.equal(PublicMessageChoice.parse({ channel: 'email', choice: 'stop' }).choice, 'stop');
    assert.throws(() => PublicMessageChoice.parse({ channel: 'sms', choice: 'pause' }));
  });
  it('allows online payments and bill checkouts', () => {
    const payment = Payment.parse({
      ...base,
      id: 'payment:1',
      type: 'payment',
      patientId: 'TEST-000001-K2',
      receiptNumber: 'TEST-R-000001-K2',
      method: 'online',
      incomingTransferId: 'incoming_transfer:1',
      amountMinor: 100,
      currency: 'NGN',
      allocations: [{ chargeId: 'charge:1', amountMinor: 100 }],
    });
    assert.equal(payment.method, 'online');
    const transfer = IncomingTransfer.parse({
      ...base,
      id: 'incoming_transfer:1',
      type: 'incoming_transfer',
      provider: 'paystack',
      mode: 'live',
      providerReference: 'ref-1',
      amountMinor: 100,
      currency: 'NGN',
      receivedOn: base.createdOn,
      channel: 'checkout',
      billKey: 'TEST-000001-K2|NGN|visit:x',
    });
    assert.equal(transfer.channel, 'checkout');
    assert.throws(() => IncomingTransfer.parse({ ...transfer, channel: 'card' }));
  });
});
