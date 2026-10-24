import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Staff, staffPermissions } from '../src/index.ts';

const staff = { id: 'staff:one', staffId: 'staff:one', type: 'staff', facilityId: 'TEST-PHC',
  createdBy: 'admin', createdOn: '2026-10-24T10:00:00Z', deviceId: 'device:test', fullName: 'Test Cashier', role: 'cashier' };
describe('staff login access', () => {
  it('reads existing staff without a new access setting', () => assert.equal(Staff.parse(staff).loginAccess, undefined));
  it('accepts scheduled or around-the-clock access and rejects unknown modes', () => {
    for (const loginAccess of ['shift', 'always']) assert.equal(Staff.parse({ ...staff, loginAccess }).loginAccess, loginAccess);
    assert.equal(Staff.safeParse({ ...staff, loginAccess: 'admin' }).success, false);
  });
  it('does not grant more capabilities when 24-hour access is assigned', () => {
    assert.deepEqual(staffPermissions(Staff.parse({ ...staff, loginAccess: 'always' })), ['payment:receive']);
    assert.deepEqual(staffPermissions(Staff.parse({ ...staff, loginAccess: 'always', permission: 'read_only' })), []);
  });
});
