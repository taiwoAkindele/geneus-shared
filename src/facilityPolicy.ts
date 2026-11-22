import type { Permission } from './capabilities.ts';
import type { FacilityDocumentType } from './facilityTypes.ts';
import {
  FACILITY_CONTRACT_VERSION,
  FACILITY_MIN_POLICY_VERSION,
  FACILITY_MIN_SCHEMA_VERSION,
} from './facilityTypes.ts';
import { z } from 'zod';

/** Both consumers must use this metadata; it is not server enforcement by itself. */
type DocumentPolicy = {
  writer: 'device' | 'server' | 'device_or_server';
  change: 'revision' | 'versioned' | 'append_only' | 'server_projection';
  visibility: 'operational' | 'restricted';
  permission?: Permission;
};

export const FACILITY_DOCUMENT_POLICY = {
  location: {
    writer: 'device',
    change: 'revision',
    visibility: 'operational',
    permission: 'location:manage',
  },
  service_definition: {
    writer: 'device',
    change: 'revision',
    visibility: 'operational',
    permission: 'service:manage',
  },
  service_offering: {
    writer: 'device',
    change: 'revision',
    visibility: 'operational',
    permission: 'service:manage',
  },
  practitioner_profile: {
    writer: 'device',
    change: 'revision',
    visibility: 'operational',
    permission: 'practitioner:manage',
  },
  credential: {
    writer: 'device_or_server',
    change: 'versioned',
    visibility: 'restricted',
    permission: 'credential:manage',
  },
  capability_decision: {
    writer: 'device_or_server',
    change: 'versioned',
    visibility: 'restricted',
    permission: 'clinical_capability:review',
  },
  reviewer_delegation: {
    writer: 'device',
    change: 'versioned',
    visibility: 'restricted',
    permission: 'clinical_capability:review',
  },
  clinical_authority_bootstrap: { writer: 'server', change: 'versioned', visibility: 'restricted' },
  external_clinical_reviewer: { writer: 'server', change: 'revision', visibility: 'restricted' },
  authority_snapshot: { writer: 'server', change: 'server_projection', visibility: 'operational' },
  staff_assignment: {
    writer: 'device',
    change: 'versioned',
    visibility: 'operational',
    permission: 'staff_assignment:manage',
  },
  service_session: {
    writer: 'device',
    change: 'versioned',
    visibility: 'operational',
    permission: 'service_session:manage',
  },
  session_event: {
    writer: 'device',
    change: 'append_only',
    visibility: 'operational',
    permission: 'service_session:operate',
  },
  work_ownership_event: {
    writer: 'device',
    change: 'append_only',
    visibility: 'operational',
    permission: 'work_ownership:claim',
  },
  appointment_reservation: {
    writer: 'server',
    change: 'server_projection',
    visibility: 'operational',
  },
  // Edited on any device, offline included; the server checks each revision when it syncs.
  result_template: {
    writer: 'device',
    change: 'revision',
    visibility: 'operational',
    permission: 'result_template:manage',
  },
  result_part: {
    writer: 'device',
    change: 'revision',
    visibility: 'operational',
    permission: 'result_template:manage',
  },
  answer_list: {
    writer: 'device',
    change: 'revision',
    visibility: 'operational',
    permission: 'result_template:manage',
  },
  // The server's standard lists, copied into every facility so they can be adopted offline.
  standard_test: { writer: 'server', change: 'server_projection', visibility: 'operational' },
  standard_template: { writer: 'server', change: 'server_projection', visibility: 'operational' },
} as const satisfies Record<FacilityDocumentType, DocumentPolicy>;

export const FacilityFeatureSupport = z.strictObject({
  contractVersion: z.literal(FACILITY_CONTRACT_VERSION),
  minimumSchemaVersion: z.literal(FACILITY_MIN_SCHEMA_VERSION),
  minimumPolicyVersion: z.literal(FACILITY_MIN_POLICY_VERSION),
});

export type FacilityFeatureSupport = z.infer<typeof FacilityFeatureSupport>;

/** Transport precondition; consumers must compare under the same lock as the write. */
export const ConfigurationPrecondition = z.strictObject({
  expectedRevision: z.number().int().positive(),
});

export type ConfigurationPrecondition = z.infer<typeof ConfigurationPrecondition>;

export const configurationRevisionIssues = (
  expected: number | undefined,
  current: number | undefined,
): string[] =>
  !Number.isInteger(expected) || expected! < 1 || expected !== (current ?? 1)
    ? [
        'Configuration changed or its expected revision is missing; reload before applying this edit',
      ]
    : [];

/**
 * Configuration: facility-wide settings saved only online, confirmed by the
 * server before they count, never queued on a device for later upload.
 * Daily operations (patients, care, billing transactions) stay offline-first.
 */
export const CONFIGURATION_TYPES = [
  'fee_item',
  'billing_department',
  'unit',
  'location',
  'service_definition',
  'service_offering',
  'practitioner_profile',
  'credential',
  'capability_decision',
  'reviewer_delegation',
  'staff',
  'roster_shift',
  'staff_assignment',
  'service_session',
  'stock_item',
  'register_definition',
  'result_template',
  'result_part',
  'answer_list',
] as const;

/** Whether a write is configuration. Extending one's own shift at its end is operational, so it stays offline-capable. */
export const isConfigurationWrite = (
  table: string,
  op: 'put' | 'patch' | 'delete',
  changedFields: readonly string[] = [],
): boolean => {
  if (!(CONFIGURATION_TYPES as readonly string[]).includes(table)) {
    return false;
  }

  if (table === 'roster_shift' && op === 'patch') {
    const meaningful = changedFields.filter(
      (field) => !['updatedBy', 'updatedOn', 'id'].includes(field),
    );

    if (meaningful.length && meaningful.every((field) => field === 'extendedUntil')) {
      return false;
    }
  }

  return true;
};
