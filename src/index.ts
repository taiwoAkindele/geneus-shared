/**
 * Geneus Health — shared contract: public entry point.
 *
 * Import everything from here:
 *   import { Patient, AnyDocument, parseDocument } from '<path-to-submodule>/src';
 *
 * This is a plain git-submodule folder (no package.json). The consuming repo
 * supplies `zod` and its own tsconfig. Relative imports carry an explicit `.ts`
 * extension so both consumers resolve them: Vite in geneus-web, and Node's own
 * type stripping in geneus-server. See README.md.
 */
import { z } from 'zod';

export * from './common.ts';
export * from './documents.ts';
export * from './permissions.ts';
export * from './api.ts';

import {
  Patient,
  Visit,
  Handoff,
  Appointment,
  RegisterDefinition,
  RegisterEntry,
  Referral,
  StockItem,
  StockMovement,
  Facility,
  Unit,
  Staff,
  RosterShift,
  Device,
  AuditEvent,
  SyncRejection,
} from './documents.ts';

/**
 * The union of every synced record. Kept a plain `z.union` (not a
 * discriminated union) for simplicity — validation just tries each member. When
 * you already know the `type`, prefer the specific schema via `parseDocument`.
 * Note a `register_entry`'s per-field rules are validated separately, against its
 * register definition — see `validateRegisterEntry` (documents.ts).
 */
export const AnyDocument = z.union([
  Patient,
  Visit,
  Handoff,
  Appointment,
  RegisterDefinition,
  RegisterEntry,
  Referral,
  StockItem,
  StockMovement,
  Facility,
  Unit,
  Staff,
  RosterShift,
  Device,
  AuditEvent,
  SyncRejection,
]);
export type AnyDocument = z.infer<typeof AnyDocument>;

/** Map of `type` → schema, for validating a record when its type is known. */
export const SCHEMA_BY_TYPE = {
  patient: Patient,
  visit: Visit,
  handoff: Handoff,
  appointment: Appointment,
  register_definition: RegisterDefinition,
  register_entry: RegisterEntry,
  referral: Referral,
  stock_item: StockItem,
  stock_movement: StockMovement,
  facility: Facility,
  unit: Unit,
  staff: Staff,
  roster_shift: RosterShift,
  device: Device,
  audit_event: AuditEvent,
  sync_rejection: SyncRejection,
} as const;

/**
 * Validate an unknown value as a record. If it carries a known `type`, the
 * matching schema is used for precise errors; otherwise it falls back to the
 * full union. Returns Zod's SafeParseReturn — the caller decides how to react
 * (reject the write, queue for the reconcile queue, etc.).
 *
 * Use this on EVERY write path (geneus-web before the SQLite write,
 * geneus-server on upload) — a bad record written offline may not surface until
 * it syncs, up to 7 days later (root §4.3).
 */
export function parseDocument(input: unknown) {
  const type = (input as { type?: unknown })?.type;
  if (typeof type === 'string' && type in SCHEMA_BY_TYPE) {
    return SCHEMA_BY_TYPE[type as keyof typeof SCHEMA_BY_TYPE].safeParse(input);
  }
  return AnyDocument.safeParse(input);
}
