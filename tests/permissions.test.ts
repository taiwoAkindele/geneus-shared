import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide,
  HIGH_RISK_PERMISSIONS,
  isWithinOfflineWindow,
  OFFLINE_AUTHORIZATION_POLICY,
  paymentPermission,
  Permission,
  PROTECTED_PERMISSIONS,
  permissionsFor,
  ROLE_PERMISSIONS,
} from '../src/permissions.ts';
import { Role } from '../src/documents.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-12T12:00:00Z');
const agoIso = (ms: number) => new Date(NOW - ms).toISOString();

/**
 * The matrix is the one thing the device and the server must agree on, so it is
 * pinned by behaviour here: which roles hold which capabilities, and what
 * read-only takes away.
 */
describe('role permissions', () => {
  it('lets a nurse record care but not manage people', () => {
    const nurse = permissionsFor('nurse', 'read_write');

    assert.ok(nurse.includes('register_entry:create'));
    assert.ok(nurse.includes('patient:create'));
    assert.equal(nurse.includes('staff:manage'), false);
    assert.equal(nurse.includes('device:enroll'), false);
  });

  /** Roles decide who may do what, not where they stand (PRD §9.8.2). */
  it('lets every clinical role record an encounter step, and not the front desk', () => {
    for (const role of ['chew', 'nurse', 'doctor', 'supervisor'] as const) {
      assert.ok(permissionsFor(role, 'read_write').includes('encounter:record'), role);
    }
    assert.equal(permissionsFor('records_officer', 'read_write').includes('encounter:record'), false);
    assert.equal(permissionsFor('cashier', 'read_write').includes('encounter:record'), false);
  });

  it('grants doctor-only actions to doctors and not to CHEWs', () => {
    assert.ok(permissionsFor('doctor', 'read_write').includes('referral:update'));
    assert.equal(permissionsFor('chew', 'read_write').includes('referral:update'), false);
  });

  it('gives the supervisor the shift extension and nobody else below admin', () => {
    for (const role of Role.options) {
      const holds = ROLE_PERMISSIONS[role].includes('roster:extend');
      assert.equal(holds, role === 'supervisor' || role === 'facility_admin', role);
    }
  });

  it('gives the facility admin every role-granted permission, so a facility can configure itself alone', () => {
    const roleGranted = Permission.options.filter((permission) => !PROTECTED_PERMISSIONS.includes(permission));
    assert.deepEqual([...ROLE_PERMISSIONS.facility_admin].sort(), [...roleGranted].sort());
  });

  /** Only the person a PIN setup code was issued for may claim it (SCHEMA.md §10). */
  it('grants the PIN setup code claim to no role', () => {
    for (const role of Role.options) {
      assert.equal(ROLE_PERMISSIONS[role].includes('pin_setup_code:claim'), false, role);
    }
  });

  it('strips every permission from read-only staff, whatever their role', () => {
    for (const role of Role.options) {
      assert.deepEqual(permissionsFor(role, 'read_only'), [], role);
    }
  });

  it('grants every other permission to at least one role, so none is unreachable', () => {
    for (const permission of Permission.options.filter((candidate) => !PROTECTED_PERMISSIONS.includes(candidate))) {
      const holders = Role.options.filter((role) => ROLE_PERMISSIONS[role].includes(permission));
      assert.ok(holders.length > 0, `${permission} is granted to no role`);
    }
  });

  /** The cashier takes money and records no care (PRD §9.13.4). */
  it('lets the cashier take payments and nothing else', () => {
    assert.deepEqual([...permissionsFor('cashier', 'read_write')], ['payment:receive']);
  });

  /** Booking raises the visit's fees in the same save, so whoever may book may raise them (PRD §9.13.3). */
  it('lets everyone who may book an appointment raise its fees', () => {
    for (const role of Role.options) {
      const permissions = ROLE_PERMISSIONS[role];
      if (permissions.includes('appointment:create')) assert.ok(permissions.includes('charge:create'), role);
    }
  });

  it('keeps waiving and reversing payments to supervisors and admins', () => {
    for (const permission of ['payment:waive', 'payment:reverse'] as const) {
      const holders = Role.options.filter((role) => ROLE_PERMISSIONS[role].includes(permission));
      assert.deepEqual(holders.sort(), ['facility_admin', 'supervisor'], permission);
    }
  });

  it('keeps the fee schedule to the facility admin', () => {
    const holders = Role.options.filter((role) => ROLE_PERMISSIONS[role].includes('fee_item:manage'));
    assert.deepEqual(holders, ['facility_admin']);
  });

  it('names the permission a payment needs from what it does', () => {
    assert.equal(paymentPermission({ method: 'cash', reverses: undefined }), 'payment:receive');
    assert.equal(paymentPermission({ method: 'waiver', reverses: undefined }), 'payment:waive');
    assert.equal(paymentPermission({ method: 'waiver', reverses: 'payment:1' }), 'payment:reverse');
    assert.equal(paymentPermission({ method: 'pos', reverses: 'payment:1' }), 'payment:reverse');
  });

  /** Clinical history is retired by flag, never destroyed (SCHEMA.md §6). */
  it('defines no delete permission for anything', () => {
    assert.equal(Permission.options.some((permission) => permission.endsWith(':delete')), false);
  });

  it('marks only access-changing actions as high risk', () => {
    for (const permission of HIGH_RISK_PERMISSIONS) {
      assert.match(permission, /^(staff|device|practitioner|credential|clinical_capability|staff_assignment):/);
    }
    assert.equal(HIGH_RISK_PERMISSIONS.includes('patient:update'), false);
  });
});

describe('offline authorization window', () => {
  it('is 7 days for ordinary work and 24 hours for high-risk actions', () => {
    assert.equal(OFFLINE_AUTHORIZATION_POLICY.generalMs, 7 * DAY);
    assert.equal(OFFLINE_AUTHORIZATION_POLICY.highRiskMs, 24 * HOUR);
  });

  it('lets a nurse keep recording care six days into an outage', () => {
    assert.ok(isWithinOfflineWindow('register_entry:create', agoIso(6 * DAY), NOW));
  });

  it('freezes ordinary work once the device has been dark for more than 7 days', () => {
    assert.equal(isWithinOfflineWindow('register_entry:create', agoIso(7 * DAY + 1), NOW), false);
  });

  it('refuses a staff change after 25 hours without server contact', () => {
    assert.equal(isWithinOfflineWindow('staff:manage', agoIso(25 * HOUR), NOW), false);
    assert.ok(isWithinOfflineWindow('staff:manage', agoIso(23 * HOUR), NOW));
  });

  it('treats a device that has never made contact as out of every window', () => {
    assert.equal(isWithinOfflineWindow('register_entry:create', undefined, NOW), false);
  });

  /** A device clock set into the future must not extend its own window. */
  it('does not accept a last-contact time that is in the future', () => {
    assert.equal(isWithinOfflineWindow('register_entry:create', agoIso(-HOUR), NOW), false);
  });
});

describe('decide', () => {
  const nurse = {
    permissions: [...permissionsFor('nurse', 'read_write')],
    lastServerContactOn: agoIso(2 * DAY),
  };

  it('allows a granted, fresh permission', () => {
    assert.equal(decide(nurse, 'register_entry:create', NOW), undefined);
  });

  it('names the missing permission when it is not granted', () => {
    assert.deepEqual(decide(nurse, 'staff:manage', NOW), { kind: 'not_granted', permission: 'staff:manage' });
  });

  it('reports staleness separately, so the UI can say "reconnect" rather than "not allowed"', () => {
    const admin = { permissions: [...ROLE_PERMISSIONS.facility_admin], lastServerContactOn: agoIso(2 * DAY) };

    assert.deepEqual(decide(admin, 'staff:manage', NOW), {
      kind: 'stale_authorization',
      permission: 'staff:manage',
      lastServerContactOn: admin.lastServerContactOn,
    });
    assert.equal(decide(admin, 'patient:update', NOW), undefined);
  });
});
