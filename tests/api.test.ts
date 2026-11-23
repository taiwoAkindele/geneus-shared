import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceCredential,
  DevicePasswordSignIn,
  DevicePasswordSignInConfirm,
  emailAddress,
  emailCode,
  FacilityRegistration,
  StaffPasswordReset,
  StaffPasswordSignIn,
  StaffPinEnrol,
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
  adminEmail: 'amaka@example.org',
  emailCode: '482193',
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

  /** Recovery depends on it, so a registration without a proven email is incomplete (SCHEMA.md §10). */
  it('requires the admin email and its verification code', () => {
    const { adminEmail: _email, ...withoutEmail } = registration;
    assert.equal(FacilityRegistration.safeParse(withoutEmail).success, false);
    assert.equal(
      FacilityRegistration.safeParse({ ...registration, emailCode: '12345' }).success,
      false,
    );
  });

  it('stores an email as typed on a phone would be compared: trimmed and lower-case', () => {
    assert.equal(emailAddress.parse('  Amaka@Example.ORG '), 'amaka@example.org');
    assert.equal(emailAddress.safeParse('not an email').success, false);
    assert.equal(emailCode.parse(' 482193 '), '482193');
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
    assert.equal(
      Object.keys(DeviceCredential.shape).some((key) => /staff|user|role/i.test(key)),
      false,
    );
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
      rejected: [
        { clientId: 8, table: 'patient', id: 'x', category: 'authorization', reason: 'no' },
      ],
      serverTime: '2026-09-12T09:30:00+01:00',
    });

    assert.equal(response.duplicates, 2);
  });
});

describe('StaffPinEnrol', () => {
  const base = { staffId: 'staff-1', pin: '123456' };
  const grant = 'g'.repeat(43);

  it('accepts exactly one proof', () => {
    assert.equal(StaffPinEnrol.safeParse({ ...base, pinGrant: grant }).success, true);
    assert.equal(StaffPinEnrol.safeParse({ ...base, setupCode: 'ABCD2345' }).success, true);
    assert.equal(StaffPinEnrol.safeParse({ ...base, emailCode: '123456' }).success, false);
    assert.equal(StaffPinEnrol.safeParse(base).success, false);
    assert.equal(
      StaffPinEnrol.safeParse({ ...base, pinGrant: grant, setupCode: 'ABCD2345' }).success,
      false,
    );
  });

  it('takes a first password only with an invitation or setup code', () => {
    assert.equal(
      StaffPinEnrol.safeParse({ ...base, setupCode: 'ABCD2345', password: 'long enough' }).success,
      true,
    );
    assert.equal(
      StaffPinEnrol.safeParse({ ...base, pinGrant: grant, password: 'long enough' }).success,
      false,
    );
    assert.equal(
      StaffPinEnrol.safeParse({ ...base, setupCode: 'ABCD2345', password: 'short' }).success,
      false,
    );
  });
});

describe('staff passwords', () => {
  it('normalises the email it signs in with', () => {
    const parsed = StaffPasswordSignIn.parse({ email: ' Nurse@Example.COM ', password: 'x' });

    assert.equal(parsed.email, 'nurse@example.com');
  });

  it('needs the 6-digit code and a long enough new password to reset', () => {
    const reset = { email: 'nurse@example.com', code: '123456', password: 'long enough' };

    assert.equal(StaffPasswordReset.safeParse(reset).success, true);
    assert.equal(StaffPasswordReset.safeParse({ ...reset, code: '12345' }).success, false);
    assert.equal(StaffPasswordReset.safeParse({ ...reset, password: 'short' }).success, false);
  });
});

describe('accepting an invitation with an existing password', () => {
  const base = { staffId: 'staff-1', pin: '123456', setupCode: 'ABCD2345' };

  it('takes the current password or an email code, never both with a new password', () => {
    assert.equal(
      StaffPinEnrol.safeParse({ ...base, existingAccount: { currentPassword: 'mine' } }).success,
      true,
    );
    assert.equal(
      StaffPinEnrol.safeParse({ ...base, existingAccount: { accountCode: '123456' } }).success,
      true,
    );
    assert.equal(
      StaffPinEnrol.safeParse({
        ...base,
        password: 'long enough',
        existingAccount: { currentPassword: 'mine' },
      }).success,
      false,
    );
  });

  it('is only part of accepting an invitation', () => {
    const { setupCode: _setupCode, ...withoutCode } = base;

    assert.equal(
      StaffPinEnrol.safeParse({
        ...withoutCode,
        emailCode: '123456',
        existingAccount: { currentPassword: 'mine' },
      }).success,
      false,
    );
  });
});

describe('new device sign-in', () => {
  it('needs the code and the device it was sent for', () => {
    const confirm = { email: 'Nurse@Example.org', deviceId: 'device-1', code: '123456' };

    assert.equal(DevicePasswordSignInConfirm.parse(confirm).email, 'nurse@example.org');
    assert.equal(DevicePasswordSignInConfirm.safeParse({ ...confirm, code: 'abc' }).success, false);
    assert.equal(
      DevicePasswordSignIn.safeParse({ email: 'nurse@example.org', password: 'x' }).success,
      false,
      'the device id is required',
    );
  });
});
