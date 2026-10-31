import { Permission } from './capabilities.ts';
import { SCHEMA_VERSION } from './common.ts';
import { POLICY_VERSION } from './permissions.ts';
import { FACILITY_DOCUMENT_TYPES } from './facilityTypes.ts';
import { FACILITY_DOCUMENT_POLICY, configurationRevisionIssues, type FacilityFeatureSupport } from './facilityPolicy.ts';

export type FacilityMutation = {
  table: string; id: string; op: 'put' | 'patch' | 'delete'; data: Record<string, unknown>;
  expectedRevision?: number; expectedPreviousId?: string | null;
};
const has = (value: object, key: string) => Object.hasOwn(value, key);
const protectedRoles = new Set(['laboratory_staff', 'pharmacy_staff']);
const v10Permissions = new Set(Permission.options.filter((p) => /^(location|service|practitioner|credential|clinical_capability|staff_assignment|service_session|work_ownership|clinical):/.test(p)));
export const requiresFacilityContract = (mutation: Pick<FacilityMutation, 'table' | 'data'>): boolean => {
  if (FACILITY_DOCUMENT_TYPES.some((type) => type === mutation.table)) return true;
  const data = mutation.data;
  if (mutation.table === 'facility' && (has(data, 'workforcePolicy') || has(data, 'timeZone'))) return true;
  if (mutation.table === 'unit' && ['kind', 'parentId', 'routingEnabled', 'revision'].some((key) => has(data, key))) return true;
  if (mutation.table === 'billing_department' && ['organizationUnitId', 'revision'].some((key) => has(data, key))) return true;
  if (mutation.table === 'appointment' && has(data, 'allocation')) return true;
  if (mutation.table === 'sync_rejection' && ['visibility', 'visibleToStaffIds', 'dependencies'].some((key) => has(data, key))) return true;
  if (['encounter_entry', 'clinical_event'].includes(mutation.table) && has(data, 'actorContext')) return true;
  return mutation.table === 'staff' && (protectedRoles.has(String(data.role))
    || Array.isArray(data.additionalRoles) && data.additionalRoles.some((r) => protectedRoles.has(r))
    || Array.isArray(data.additionalPermissions) && data.additionalPermissions.some((p) => v10Permissions.has(p)));
};
export const facilityCompatibilityIssues = (request: {
  facilityContractVersion?: number; schemaVersion?: number; policyVersion?: number; mutations: readonly Pick<FacilityMutation, 'table' | 'data'>[];
}, serverSupport: FacilityFeatureSupport | undefined, authorityCutoverActive = false): string[] => {
  const required = authorityCutoverActive || request.mutations.some(requiresFacilityContract);
  if (!required) return [];
  if (!serverSupport) return ['Server has not enabled the facility contract; preserve queued writes and require an upgrade'];
  return request.facilityContractVersion === serverSupport.contractVersion && (request.schemaVersion ?? 0) >= serverSupport.minimumSchemaVersion && (request.schemaVersion ?? Infinity) <= SCHEMA_VERSION
    && (request.policyVersion ?? 0) >= serverSupport.minimumPolicyVersion && (request.policyVersion ?? Infinity) <= POLICY_VERSION ? [] : ['Client schema/policy/feature contract is incompatible; preserve its queued writes'];
};

/** Complements shape/permission validation. Database CAS/serialization remains mandatory. */
export const facilityMutationIssues = (mutation: FacilityMutation, current?: { revision?: number; id: string }): string[] => {
  if (mutation.table === 'facility' && ['workforcePolicy', 'timeZone'].some((key) => has(mutation.data, key))) return ['Facility cutover and authoritative timezone are server-owned'];
  if (requiresFacilityContract(mutation) && (typeof mutation.data.schemaVersion !== 'number' || mutation.data.schemaVersion < 4 || mutation.data.schemaVersion > SCHEMA_VERSION)) return ['New facility writes require a supported schema version, from 4 through the current schema'];
  const legacyConfiguration = ['unit', 'billing_department'].includes(mutation.table) && requiresFacilityContract(mutation);
  const policy = legacyConfiguration ? { writer: 'device', change: 'revision' } : Object.hasOwn(FACILITY_DOCUMENT_POLICY, mutation.table)
    ? FACILITY_DOCUMENT_POLICY[mutation.table as keyof typeof FACILITY_DOCUMENT_POLICY] : undefined;
  if (!policy) return [];
  if (current && current.id !== mutation.id) return ['Current configuration identity does not match the mutation'];
  if (policy.writer === 'server' || mutation.data.externalReviewerId || mutation.data.createdBy === 'system') return ['This record/provenance is server-owned and cannot be uploaded'];
  if (mutation.op === 'delete') return ['Facility history is retained; use an explicit retirement/ending event'];
  if (policy.change === 'versioned' || policy.change === 'append_only') {
    if (mutation.op !== 'put') return ['Events and revisions are immutable'];
    if (policy.change === 'versioned' && (!has(mutation, 'expectedPreviousId') || mutation.expectedPreviousId !== (mutation.data.previousId ?? null))) return ['Versioned writes require their exact expected predecessor, including null on create'];
    return current ? ['This immutable record already exists; exact retry is handled by mutation deduplication'] : [];
  }
  if (!current) return mutation.op === 'put' && mutation.data.revision === 1 ? [] : ['New configuration must start at revision one'];
  const issues = configurationRevisionIssues(mutation.expectedRevision, current.revision);
  if (mutation.data.revision !== (current.revision ?? 1) + 1) issues.push('Configuration revision must increment exactly once');
  return issues;
};
