import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceCredential,
  FacilityRegistration,
  SyncTokenClaims,
  UploadMutation,
  UploadRequest,
  UploadResponse,
} from '../src/api.ts';

const registration = {
  code: 'OOE-PHC',
  name: 'Odo-Ona Elewe PHC',
  state: 'Oyo',
  lga: 'Ibadan SW',
  level: 'phc',
  adminFullName: 'Amaka Okoro',
  deviceId: 'device-one',
  inviteToken: 'ABCDEFGHJK',
};

describe('facility registration', () => {
  it('accepts a well-formed registration', () => {
    assert.ok(FacilityRegistration.safeParse(registration).success);
  });

  /** The code prefixes every Patient ID, so a lowercase or spaced one would break PATIENT_ID_RE. */
  it('rejects a facility code that could not prefix a Patient ID', () => {
    for (const code of ['ooe-phc', 'OOE PHC', 'OOE-', 'X']) {
      assert.equal(FacilityRegistration.safeParse({ ...registration, code }).success, false, code);
    }
  });
});

describe('device credential', () => {
  it('is facility-scoped and points the device at its sync endpoint', () => {
    const credential = DeviceCredential.parse({
      deviceId: 'device-one',
      facilityId: 'OOE-PHC',
      credential: 'opaque-secret',
      syncEndpoint: 'https://sync.example.org',
    });

    assert.equal(credential.facilityId, 'OOE-PHC');
  });

  it('carries no human identity — a device is where, not who', () => {
    assert.equal(Object.keys(DeviceCredential.shape).some((key) => /staff|user|role/i.test(key)), false);
  });
});

describe('sync token claims', () => {
  it('subject is the device and the facility rides as its own claim', () => {
    const claims = SyncTokenClaims.parse({
      sub: 'device-one',
      aud: 'powersync',
      iat: 1_757_670_000,
      exp: 1_757_673_600,
      facility_id: 'OOE-PHC',
    });

    assert.equal(claims.sub, 'device-one');
    assert.equal(claims.facility_id, 'OOE-PHC');
  });
});

describe('upload', () => {
  const mutation = {
    clientId: 7,
    op: 'put',
    table: 'patient',
    id: 'OOE-PHC-000047-K2',
    data: { fullName: 'Amaka Okoro' },
  };

  it('accepts a transaction of typed mutations', () => {
    assert.ok(UploadRequest.safeParse({ transactionId: 3, mutations: [mutation] }).success);
    assert.ok(UploadRequest.safeParse({ transactionId: null, mutations: [mutation] }).success);
  });

  it('refuses an empty transaction and an unknown table', () => {
    assert.equal(UploadRequest.safeParse({ transactionId: 3, mutations: [] }).success, false);
    assert.equal(UploadMutation.safeParse({ ...mutation, table: 'prescriptions' }).success, false);
  });

  it('acknowledges duplicates separately from applied and rejected', () => {
    const response = UploadResponse.parse({
      applied: 1,
      duplicates: 2,
      rejected: [{ clientId: 8, table: 'patient', id: 'x', category: 'authorization', reason: 'no' }],
      serverTime: '2026-09-12T09:30:00+01:00',
    });

    assert.equal(response.duplicates, 2);
  });
});
