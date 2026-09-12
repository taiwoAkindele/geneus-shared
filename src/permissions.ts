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
import { Role, StaffPermission } from './documents.ts';

/**
 * Bump when the matrix or the policy windows change. Devices carry the version
 * they authorised against, so a stale device is visible at sync rather than
 * silently applying yesterday's rules.
 */
export const POLICY_VERSION = 1 as const;

/**
 * One explicit capability per action the system can perform. Every mutation a
 * repository makes maps to exactly one of these. There is deliberately no
 * `*:delete` for any record: clinical history is retired by flag, never
 * destroyed, and the server rejects deletes outright (SCHEMA.md §6).
 */
export const Permission = z.enum([
  // Front desk / clinical
  'patient:create',
  'patient:update',
  'appointment:create',
  'visit:create',
  'handoff:create',
  'handoff:update',
  'referral:create',
  'referral:update',
  'register_entry:create',
  'stock_movement:create',
  // Facility configuration
  'register_definition:publish',
  'unit:manage',
  'stock_item:manage',
  // People and access
  'staff:manage',
  'staff:permission',
  'staff:deactivate',
  'roster:assign',
  'roster:extend',
  'device:enroll',
  'device:revoke',
  // Reconciliation
  'sync_rejection:resolve',
]);
export type Permission = z.infer<typeof Permission>;

const CLINICAL: readonly Permission[] = [
  'patient:create',
  'patient:update',
  'appointment:create',
  'visit:create',
  'handoff:create',
  'handoff:update',
  'referral:create',
  'register_entry:create',
  'stock_movement:create',
];

const FRONT_DESK: readonly Permission[] = [
  'patient:create',
  'patient:update',
  'appointment:create',
  'register_entry:create',
  'register_definition:publish',
  'sync_rejection:resolve',
];

/**
 * What each role may do. Roles are the PRD's job titles (§7.1, §14.1); the
 * matrix is the smallest one that covers what the app persists today.
 * `facility_admin` holds everything by construction — a facility must be able
 * to configure itself with no one else's help (<60-minute onboarding, PRD §8).
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  chew: CLINICAL,
  nurse: CLINICAL,
  doctor: [...CLINICAL, 'referral:update'],
  supervisor: [...CLINICAL, 'referral:update', 'roster:extend'],
  records_officer: FRONT_DESK,
  facility_admin: Permission.options,
};

/**
 * The permissions a member of staff actually holds: the role's set, emptied
 * entirely for `read_only` staff. Every permission here is a mutation, so
 * read-only means "none of them" — the same rule `assertCanWrite` enforced
 * before v3, now expressed per capability.
 */
export const permissionsFor = (role: Role, staffPermission: StaffPermission): readonly Permission[] =>
  staffPermission === 'read_only' ? [] : ROLE_PERMISSIONS[role];

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
