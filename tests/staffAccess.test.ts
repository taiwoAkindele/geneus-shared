import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Staff, mayApprovePin, rolesFor, staffPermissions } from '../src/index.ts';

const member = (extra: Partial<Staff> = {}): Staff => Staff.parse({
  id: 'staff:one', staffId: 'staff:one', type: 'staff', facilityId: 'TEST-PHC',
  createdBy: 'staff:admin', createdOn: '2026-10-22T10:00:00Z', deviceId: 'device:one',
  fullName: 'Test Staff', role: 'nurse', ...extra,
});

describe('combined staff access', () => {
  it('keeps legacy single-role staff valid', () => {
    const staff = member();
    assert.deepEqual(rolesFor(staff), ['nurse']);
    assert.ok(staffPermissions(staff).includes('encounter:record'));
    assert.equal(staff.additionalRoles, undefined);
  });
  it('combines selected roles and individual grants without duplicate capabilities', () => {
    const staff = member({ additionalRoles: ['cashier', 'supervisor'], additionalPermissions: ['fee_item:manage'] });
    const permissions = staffPermissions(staff);
    for (const permission of ['encounter:record', 'payment:receive', 'roster:extend', 'fee_item:manage'] as const) assert.ok(permissions.includes(permission));
    assert.equal(new Set(permissions).size, permissions.length);
    assert.equal(permissions.includes('staff:permission'), false);
  });
  it('makes read-only override all roles and grants', () => {
    assert.deepEqual(staffPermissions(member({ permission: 'read_only', additionalRoles: ['facility_admin'], additionalPermissions: ['payment:receive'] })), []);
  });
  it('rejects unknown roles, duplicate grants and the private PIN claim capability', () => {
    for (const extra of [
      { additionalRoles: ['janitor'] }, { additionalRoles: ['nurse', 'nurse'] },
      { additionalPermissions: ['pin_setup_code:claim'] }, { additionalPermissions: ['payment:receive', 'payment:receive'] },
    ]) assert.equal(Staff.safeParse({ ...member(), ...extra }).success, false);
  });
  it('allows a secondary admin to approve accounts but refuses lower-access PIN approvers', () => {
    const admin = member({ additionalRoles: ['facility_admin'] });
    const supervisor = member({ role: 'supervisor' });
    assert.ok(mayApprovePin(admin, member()));
    assert.ok(mayApprovePin(supervisor, member()));
    assert.equal(mayApprovePin(supervisor, admin), false);
    assert.equal(mayApprovePin(member({ role: 'supervisor', permission: 'read_only' }), member()), false);
  });
  it('does not turn a delegated staff-management grant into an admin PIN takeover', () => {
    const manager = member({ additionalPermissions: ['staff:manage'] });
    assert.ok(mayApprovePin(manager, member()));
    assert.equal(mayApprovePin(manager, member({ role: 'facility_admin' })), false);
    assert.equal(mayApprovePin(member({ role: 'supervisor' }), manager), false);
  });
});
