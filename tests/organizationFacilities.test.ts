import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacilityRegistration, FacilityDetails, OrganizationFacilityRegistration } from '../src/api.ts';

const details = { name: 'Synthetic facility', code: 'SUN-LEK', state: 'Lagos', lga: 'Eti-Osa', level: 'general_hospital' };
const input = { ...details, actorStaffId: 'staff:existing', organizationId: 'org:1', requestId: '6bd124e4-4d4c-4946-88b2-1ff8457a12e0', deviceId: '6bd124e4-4d4c-4946-88b2-1ff8457a12e1', deviceSecret: 'a'.repeat(43) };
test('additional facilities collect the primary details without requiring another invite or admin email code', () => {
  assert.equal(FacilityDetails.safeParse(details).success, true);
  assert.equal(FacilityRegistration.safeParse(details).success, false);
  assert.equal(OrganizationFacilityRegistration.safeParse(input).success, true);
  assert.equal(OrganizationFacilityRegistration.safeParse({ ...input, organizationId: undefined, organizationName: 'Synthetic group' }).success, true);
  assert.equal(OrganizationFacilityRegistration.safeParse({ ...input, organizationId: undefined }).success, false);
  assert.equal(OrganizationFacilityRegistration.safeParse({ ...input, code: 'lowercase' }).success, false);
  assert.equal(OrganizationFacilityRegistration.safeParse({ ...input, deviceSecret: 'short' }).success, false);
  const parsed = OrganizationFacilityRegistration.parse({ ...input, adminEmail: 'unverified@example.org', adminFullName: 'Caller-supplied identity' });
  assert.equal('adminEmail' in parsed, false);
  assert.equal('adminFullName' in parsed, false);
});
