import { z } from 'zod';

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
  'patient_identity:review',
  'patient_identity:resolve',
  'appointment:create',
  'appointment:update',
  'visit:create',
  'encounter:record',
  'handoff:create',
  'handoff:update',
  'referral:create',
  'referral:update',
  'register_entry:create',
  'stock_movement:create',
  // Billing (PRD §9.13)
  'charge:create',
  'payment:receive',
  'payment:waive',
  'payment:reverse',
  // Facility configuration
  'register_definition:publish',
  'unit:manage',
  'stock_item:manage',
  'fee_item:manage',
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
  // Setting one's own PIN with a code an admin issued
  'pin_setup_code:claim',
]);
export type Permission = z.infer<typeof Permission>;

/** The PIN-code claim is never a permission an admin can assign. */
export const AssignablePermission = Permission.exclude(['pin_setup_code:claim']);
export type AssignablePermission = z.infer<typeof AssignablePermission>;
