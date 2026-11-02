/**
 * Geneus Health — shared contract: permissions and the offline policy.
 *
 * Defined once so that the device (deciding offline, before any SQLite write)
 * and the server (deciding on upload, before any PostgreSQL write) can never
 * disagree about what a role may do. This file is the *vocabulary and the
 * matrix*; enforcement lives in each consumer. The server's decision is the
 * authoritative one — the client's exists so offline behaviour is deterministic
 * and unauthorized actions never become mutations (root §4.3, ENGINEERING.md).
 */
import { z } from 'zod';
import { AssignablePermission, Permission } from './capabilities.ts';
export { AssignablePermission, Permission } from './capabilities.ts';
import { Role, StaffPermission, type Payment, type Staff } from './documents.ts';
import { type ClinicalAction } from './facilityTypes.ts';

/**
 * Bump when the matrix or the policy windows change. Devices carry the version
 * they authorised against, so a stale device is visible at sync rather than
 * silently applying yesterday's rules.
 * v13: managing lab result templates, granted to administrators and assignable to lab staff.
 * v12: explicit medical-history read access, separate from patient details and writes.
 * v11: explicit admission/bed-management permission for hospital clinical staff.
 * v10: facility/workforce, explicit administrative grants, protected clinical review and activity gates.
 * v9: attributed appointment attendance, rescheduling and reactivation.
 * v8: patient identity review and server-confirmed resolution.
 * v7: hospital department billing and attributed discounts/waivers.
 * v6: configurable around-the-clock sign-in; shift end no longer expires sessions.
 * v5: combined staff roles and individually assigned permissions.
 * v4: billing — the cashier role, fees, charges, payments, waivers, reversals.
 */
export const POLICY_VERSION = 13 as const;
export const READ_PERMISSIONS: readonly Permission[] = ['patient_chart:read'];
export const canReadPatientChart = (context: Pick<AuthorizationContext, 'permissions'>): boolean => context.permissions.includes('patient_chart:read');

/** Software actions are only one gate; approved clinical authority is checked separately. */
export const CLINICAL_ACTION_PERMISSIONS = {
  assess: 'clinical:assess', diagnose: 'clinical:diagnose', prescribe: 'clinical:prescribe',
  collect_specimen: 'clinical:collect_specimen', perform_test: 'clinical:perform_test', record_result: 'clinical:record_result',
  verify_result: 'clinical:verify_result', release_result: 'clinical:release_result', dispense: 'clinical:dispense', administer: 'clinical:administer',
} as const satisfies Record<ClinicalAction, Permission>;


const CLINICAL: readonly Permission[] = [
  'patient_chart:read',
  'patient:create',
  'patient:update',
  'patient_identity:review',
  'appointment:create',
  'appointment:update',
  'visit:create',
  'encounter:record',
  'handoff:create',
  'handoff:update',
  'referral:create',
  'register_entry:create',
  'stock_movement:create',
  // Booking an appointment raises its fees in the same save (PRD §9.13.3).
  'charge:create',
  'work_ownership:claim',
  'service_session:operate',
  ...Object.values(CLINICAL_ACTION_PERMISSIONS),
];

const FRONT_DESK: readonly Permission[] = [
  'patient:create',
  'patient:update',
  'patient_identity:review',
  'patient_identity:resolve',
  'appointment:create',
  'appointment:update',
  'charge:create',
  'register_entry:create',
  'register_definition:publish',
  'sync_rejection:resolve',
];

/** Takes money and records no care (PRD §9.13.4). */
const CASHIER: readonly Permission[] = ['payment:receive'];

/** Cancelling what is owed, or a payment already taken, is a supervisor's decision (PRD §9.13.4). */
const BILLING_OVERSIGHT: readonly Permission[] = ['payment:waive', 'payment:reverse'];

/**
 * Granted by no role and never individually assignable. PIN claims use the
 * claim context; clinical review uses accepted scoped reviewer authority.
 */
export const PROTECTED_PERMISSIONS: readonly Permission[] = ['pin_setup_code:claim', 'clinical_capability:review'];

/**
 * What each role may do. Roles are the PRD's job titles (§7.1, §14.1); the
 * matrix is the smallest one that covers what the app persists today.
 * `facility_admin` holds an explicit administrative set — a facility must be
 * able to configure itself with no one else's help (<60-minute onboarding,
 * PRD §8).
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  chew: CLINICAL,
  nurse: [...CLINICAL, 'admission:manage'],
  doctor: [...CLINICAL, 'admission:manage', 'referral:update'],
  supervisor: [...CLINICAL, 'admission:manage', 'referral:update', 'roster:extend', ...BILLING_OVERSIGHT],
  records_officer: FRONT_DESK,
  cashier: CASHIER,
  // Explicitly reviewed v10 list: future permission additions must not auto-escalate administrators.
  facility_admin: [...new Set<Permission>([
    ...CLINICAL, ...FRONT_DESK, ...CASHIER, ...BILLING_OVERSIGHT,
    'admission:manage', 'referral:update', 'unit:manage', 'location:manage', 'service:manage', 'result_template:manage', 'practitioner:manage', 'credential:manage', 'credential:read',
    'staff_assignment:manage', 'service_session:manage', 'work_ownership:manage',
    'stock_item:manage', 'fee_item:manage', 'staff:manage', 'staff:permission', 'staff:deactivate',
    'roster:assign', 'roster:extend', 'device:enroll', 'device:revoke',
  ])],
  laboratory_staff: ['patient_chart:read', 'patient:update', 'encounter:record', 'handoff:update', 'work_ownership:claim', 'service_session:operate',
    'clinical:collect_specimen', 'clinical:perform_test', 'clinical:record_result', 'clinical:verify_result', 'clinical:release_result'],
  pharmacy_staff: ['patient_chart:read', 'encounter:record', 'handoff:update', 'work_ownership:claim', 'service_session:operate', 'clinical:dispense'],
};

/**
 * The permission a payment record needs, decided from what it does. Shared so
 * the device that writes it and the server that receives it name the same one.
 */
export const paymentPermission = (payment: Pick<Payment, 'method' | 'reverses'>): Permission => {
  if (payment.reverses) return 'payment:reverse';
  if (payment.method === 'waiver') return 'payment:waive';
  return 'payment:receive';
};

/**
 * The permissions a member of staff actually holds. Read permissions remain usable;
 * read-only removes mutation grants — the same rule `assertCanWrite` enforced
 * before v3, now expressed per capability.
 */
export const permissionsFor = (role: Role, staffPermission: StaffPermission): readonly Permission[] =>
  staffPermission === 'read_only' ? ROLE_PERMISSIONS[role].filter(permission => READ_PERMISSIONS.includes(permission)) : ROLE_PERMISSIONS[role];

/** One primary role for attribution; additional duties contribute access too. */
export type StaffRoles = Pick<Staff, 'role' | 'additionalRoles'>;
export type StaffAccess = StaffRoles & Pick<Staff, 'permission' | 'additionalPermissions'>;

export const rolesFor = (staff: StaffRoles): Role[] => [...new Set([staff.role, ...(staff.additionalRoles ?? [])])];
export const hasRole = (staff: StaffRoles, role: Role): boolean => rolesFor(staff).includes(role);

/** Read-only removes mutations while preserving explicitly granted read access. */
export const staffPermissions = (staff: StaffAccess): Permission[] => {
  const assigned = (staff.additionalPermissions ?? []).filter((permission) => AssignablePermission.options.includes(permission));
  const granted = [...new Set([...rolesFor(staff).flatMap((role) => ROLE_PERMISSIONS[role]), ...assigned])];
  return staff.permission === 'read_only' ? granted.filter(permission => READ_PERMISSIONS.includes(permission)) : granted;
};

/** A PIN reset must not let a lower-access colleague take over a more privileged account. */
export const mayApprovePin = (approver: StaffAccess, target: StaffAccess): boolean => {
  if (approver.permission !== 'read_write') return false;
  const granted = staffPermissions(approver);
  if (!hasRole(approver, 'facility_admin') && !hasRole(approver, 'supervisor') && !granted.includes('staff:manage')) return false;
  if (hasRole(target, 'facility_admin') && !hasRole(approver, 'facility_admin')) return false;
  return staffPermissions(target).every((permission) => granted.includes(permission));
};

/* ------------------------------------------------------------------ */
/* Offline authorization policy (root §4.3, migration plan §19)        */
/* ------------------------------------------------------------------ */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a device may go without hearing from the server before cached
 * authorization stops being trusted.
 *
 * - `generalMs` — the existing 7-day sync-or-freeze window. Beyond it the
 *   device freezes logins (and therefore every permission) until it reconnects.
 * - `highRiskMs` — the stricter window for the actions in
 *   {@link HIGH_RISK_PERMISSIONS}. Only those actions need it; ordinary
 *   clinical work must keep flowing through a week-long outage.
 */
export const OFFLINE_AUTHORIZATION_POLICY = {
  generalMs: 7 * DAY_MS,
  highRiskMs: 24 * HOUR_MS,
} as const;

/**
 * Actions that change who can do what. A device that has not spoken to the
 * server in the last 24 hours may not perform them, because the server may by
 * now know something the device does not (a revoked device, a dismissed
 * admin). Clinical actions are deliberately not on this list.
 */
export const HIGH_RISK_PERMISSIONS: readonly Permission[] = [
  'staff:manage',
  'staff:permission',
  'staff:deactivate',
  'device:enroll',
  'device:revoke',
  'practitioner:manage',
  'credential:manage',
  'clinical_capability:review',
  'staff_assignment:manage',
];

export const isHighRisk = (permission: Permission): boolean => HIGH_RISK_PERMISSIONS.includes(permission);

/**
 * Whether the device's last server contact is recent enough for `permission`.
 * `lastServerContactOn` is the device's record of the server's clock at the
 * last successful sync or `/time` call — never the device's own clock alone.
 * A device that has never made contact is out of the window for everything.
 */
export const isWithinOfflineWindow = (
  permission: Permission,
  lastServerContactOn: string | undefined,
  now: number = Date.now(),
): boolean => {
  if (!lastServerContactOn) return false;
  const elapsed = now - new Date(lastServerContactOn).getTime();
  const window = isHighRisk(permission)
    ? OFFLINE_AUTHORIZATION_POLICY.highRiskMs
    : OFFLINE_AUTHORIZATION_POLICY.generalMs;
  return elapsed >= 0 && elapsed <= window;
};

/**
 * The offline snapshot of "who is acting, from where, with what rights". Built
 * by the client from the signed-in shift, the facility and the device; sent
 * nowhere — the server derives its own from the authenticated device and its
 * staff table, and never trusts a copy of this.
 */
export const AuthorizationContext = z.object({
  userId: z.string().min(1),
  facilityId: z.string().min(1),
  deviceId: z.string().min(1),
  role: Role,
  roles: z.array(Role).optional(),
  permissions: z.array(Permission),
  policyVersion: z.number().int().positive(),
  /** Server clock at the last successful contact (see isWithinOfflineWindow). */
  lastServerContactOn: z.string().optional(),
});
export type AuthorizationContext = z.infer<typeof AuthorizationContext>;

/** Why an action was refused — shared so both sides report the same reasons. */
export type Denial =
  | { kind: 'not_granted'; permission: Permission }
  | { kind: 'stale_authorization'; permission: Permission; lastServerContactOn: string | undefined };

/**
 * The one decision both sides make: is `permission` in the context's set, and
 * is the context fresh enough to exercise it? Pure, so it is trivially testable
 * and identical wherever it runs.
 */
export const decide = (
  context: Pick<AuthorizationContext, 'permissions' | 'lastServerContactOn'>,
  permission: Permission,
  now: number = Date.now(),
): Denial | undefined => {
  if (!context.permissions.includes(permission)) return { kind: 'not_granted', permission };
  if (!isWithinOfflineWindow(permission, context.lastServerContactOn, now)) {
    return { kind: 'stale_authorization', permission, lastServerContactOn: context.lastServerContactOn };
  }
  return undefined;
};
