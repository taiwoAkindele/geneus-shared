import type { Permission } from './capabilities.ts';
import type { FacilityDocumentType } from './facilityTypes.ts';
import { FACILITY_CONTRACT_VERSION, FACILITY_MIN_POLICY_VERSION, FACILITY_MIN_SCHEMA_VERSION } from './facilityTypes.ts';
import { z } from 'zod';

/** Both consumers must use this metadata; it is not server enforcement by itself. */
type DocumentPolicy = {
  writer: 'device' | 'server' | 'device_or_server';
  change: 'revision' | 'versioned' | 'append_only' | 'server_projection';
  visibility: 'operational' | 'restricted'; permission?: Permission;
};
export const FACILITY_DOCUMENT_POLICY = {
  location: { writer: 'device', change: 'revision', visibility: 'operational', permission: 'location:manage' },
  service_definition: { writer: 'device', change: 'revision', visibility: 'operational', permission: 'service:manage' },
  service_offering: { writer: 'device', change: 'revision', visibility: 'operational', permission: 'service:manage' },
  practitioner_profile: { writer: 'device', change: 'revision', visibility: 'operational', permission: 'practitioner:manage' },
  credential: { writer: 'device_or_server', change: 'versioned', visibility: 'restricted', permission: 'credential:manage' },
  capability_decision: { writer: 'device_or_server', change: 'versioned', visibility: 'restricted', permission: 'clinical_capability:review' },
  reviewer_delegation: { writer: 'device', change: 'versioned', visibility: 'restricted', permission: 'clinical_capability:review' },
  clinical_authority_bootstrap: { writer: 'server', change: 'versioned', visibility: 'restricted' },
  external_clinical_reviewer: { writer: 'server', change: 'revision', visibility: 'restricted' },
  authority_snapshot: { writer: 'server', change: 'server_projection', visibility: 'operational' },
  staff_assignment: { writer: 'device', change: 'versioned', visibility: 'operational', permission: 'staff_assignment:manage' },
  service_session: { writer: 'device', change: 'versioned', visibility: 'operational', permission: 'service_session:manage' },
  session_event: { writer: 'device', change: 'append_only', visibility: 'operational', permission: 'service_session:operate' },
  work_ownership_event: { writer: 'device', change: 'append_only', visibility: 'operational', permission: 'work_ownership:claim' },
  appointment_reservation: { writer: 'server', change: 'server_projection', visibility: 'operational' },
} as const satisfies Record<FacilityDocumentType, DocumentPolicy>;

export const FacilityFeatureSupport = z.strictObject({
  contractVersion: z.literal(FACILITY_CONTRACT_VERSION),
  minimumSchemaVersion: z.literal(FACILITY_MIN_SCHEMA_VERSION),
  minimumPolicyVersion: z.literal(FACILITY_MIN_POLICY_VERSION),
});
export type FacilityFeatureSupport = z.infer<typeof FacilityFeatureSupport>;

/** Transport precondition; consumers must compare under the same lock as the write. */
export const ConfigurationPrecondition = z.strictObject({ expectedRevision: z.number().int().positive() });
export type ConfigurationPrecondition = z.infer<typeof ConfigurationPrecondition>;
export const configurationRevisionIssues = (expected: number | undefined, current: number | undefined): string[] =>
  !Number.isInteger(expected) || expected! < 1 || expected !== (current ?? 1)
    ? ['Configuration changed or its expected revision is missing; reload before applying this edit'] : [];
