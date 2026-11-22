import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentLinkRequest,
  FacilityDetailsUpdate,
  billKey,
  billKeyParts,
  billReference,
} from '../src/index.ts';

const charge = { id: 'charge:1', patientId: 'TEST-000001-K2', currency: 'NGN' };

describe('patient documents', () => {
  it('groups a charge by its most specific source', () => {
    assert.equal(
      billKey({
        ...charge,
        billId: '0f8fad5b-d9cb-469f-a165-70867728950e',
        encounterId: 'encounter:9',
      }),
      'TEST-000001-K2|NGN|bill:0f8fad5b-d9cb-469f-a165-70867728950e',
    );

    assert.equal(
      billKey({ ...charge, encounterId: 'encounter:9', appointmentId: 'appointment:3' }),
      'TEST-000001-K2|NGN|visit:encounter:9',
    );

    assert.equal(
      billKey({ ...charge, appointmentId: 'appointment:3' }),
      'TEST-000001-K2|NGN|appointment:appointment:3',
    );

    assert.equal(billKey(charge), 'TEST-000001-K2|NGN|charge:charge:1');
  });

  it('names a bill by the end of its source', () => {
    assert.equal(
      billReference('TEST-000001-K2|NGN|bill:0f8fad5b-d9cb-469f-a165-70867728950e'),
      'B-70867728950E',
    );

    assert.equal(billReference('TEST-000001-K2|NGN|charge:charge:1'), 'B-CHARGE:1');
  });

  it('reads the patient and currency back from a key', () => {
    assert.deepEqual(billKeyParts('TEST-000001-K2|NGN|visit:encounter:9'), {
      patientId: 'TEST-000001-K2',
      currency: 'NGN',
      source: 'visit:encounter:9',
    });

    assert.equal(billKeyParts('TEST-000001-K2|naira|visit:x'), undefined);
    assert.equal(billKeyParts('nothing'), undefined);
  });

  it('accepts a link request for a bill or a receipt only', () => {
    assert.equal(
      DocumentLinkRequest.parse({ kind: 'bill', billKey: 'TEST-000001-K2|NGN|visit:encounter:9' })
        .kind,
      'bill',
    );

    assert.equal(
      DocumentLinkRequest.parse({ kind: 'receipt', paymentId: 'payment:1' }).kind,
      'receipt',
    );

    assert.throws(() => DocumentLinkRequest.parse({ kind: 'bill', billKey: 'not a bill' }));
    assert.throws(() => DocumentLinkRequest.parse({ kind: 'statement', paymentId: 'payment:1' }));
  });

  it('lets an administrator set or clear the hospital email', () => {
    const details = {
      name: 'Synthetic Hospital',
      level: 'phc',
      state: 'Lagos',
      lga: 'Ikeja',
      country: 'NG',
      currency: 'NGN',
    } as const;

    assert.equal(
      FacilityDetailsUpdate.parse({ ...details, email: ' Desk@Example.ORG ' }).email,
      'desk@example.org',
    );

    assert.equal(FacilityDetailsUpdate.parse({ ...details, email: '' }).email, '');
    assert.equal(FacilityDetailsUpdate.parse(details).email, undefined);
    assert.throws(() => FacilityDetailsUpdate.parse({ ...details, email: 'desk@' }));
  });
});
