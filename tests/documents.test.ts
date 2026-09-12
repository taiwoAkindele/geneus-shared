import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnyDocument, parseDocument, SCHEMA_BY_TYPE } from '../src/index.ts';
import { DocType, IMMUTABLE_ENVELOPE_FIELDS, SCHEMA_VERSION } from '../src/common.ts';
import { AuditEvent, Device, Patient, RosterShift, SyncRejection } from '../src/documents.ts';

const envelope = {
  facilityId: 'OOE-PHC',
  createdBy: 'staff:one',
  createdOn: '2026-09-12T09:30:00+01:00',
  deviceId: 'device-one',
};

const patient = {
  ...envelope,
  id: 'OOE-PHC-000047-K2',
  type: 'patient',
  patientId: 'OOE-PHC-000047-K2',
  fullName: 'Amaka Okoro',
  address: 'Odo-Ona',
  sex: 'female',
  ageYears: 32,
};

describe('the v3 envelope', () => {
  it('is version 3', () => {
    assert.equal(SCHEMA_VERSION, 3);
  });

  it('keys records by `id` and stamps the current schema version by default', () => {
    const parsed = Patient.parse(patient);

    assert.equal(parsed.id, 'OOE-PHC-000047-K2');
    assert.equal(parsed.schemaVersion, 3);
  });

  /** A record still carrying the CouchDB key must fail loudly, not slip through as id-less. */
  it('rejects a record that only has the old `_id`', () => {
    const { id: _id, ...legacy } = patient;

    const result = parseDocument({ ...legacy, _id: 'OOE-PHC-000047-K2' });

    assert.equal(result.success, false);
  });

  it('names the identity fields a PATCH may never move', () => {
    assert.deepEqual([...IMMUTABLE_ENVELOPE_FIELDS], ['id', 'facilityId', 'createdBy', 'createdOn', 'deviceId']);
  });
});

describe('record types', () => {
  it('has exactly one schema per document type, and the union covers all of them', () => {
    assert.deepEqual(Object.keys(SCHEMA_BY_TYPE).sort(), [...DocType.options].sort());
    assert.equal(AnyDocument.options.length, DocType.options.length);
  });

  it('accepts a roster shift that the server has not signed yet', () => {
    const shift = RosterShift.parse({
      ...envelope,
      id: 'roster_shift:staff:one:2026-09-12',
      type: 'roster_shift',
      staffId: 'staff:one',
      startsAt: '2026-09-12T08:00:00+01:00',
      endsAt: '2026-09-12T16:00:00+01:00',
    });

    assert.equal(shift.signature, undefined);
  });

  it('describes a device without ever carrying its credential', () => {
    const device = Device.parse({
      ...envelope,
      id: 'device-one',
      type: 'device',
      enrolledBy: 'staff:one',
      enrolledOn: '2026-09-12T09:00:00+01:00',
    });

    assert.equal(device.status, 'active');
    assert.equal(device.wipeRequested, false);
    assert.equal('credential' in device, false);
    assert.equal(Object.keys(Device.shape).some((key) => /credential|secret|hash/i.test(key)), false);
  });

  it('records an audit event as ok unless told otherwise, with the server clock absent until arrival', () => {
    const event = AuditEvent.parse({
      ...envelope,
      id: 'audit_event:1',
      type: 'audit_event',
      action: 'create',
      entityType: 'patient',
      entityId: patient.id,
      occurredOn: envelope.createdOn,
    });

    assert.equal(event.result, 'ok');
    assert.equal(event.receivedOn, undefined);
  });

  it('keeps audit metadata to scalars, so clinical payloads cannot be tucked into it', () => {
    const result = AuditEvent.safeParse({
      ...envelope,
      id: 'audit_event:2',
      type: 'audit_event',
      action: 'update',
      occurredOn: envelope.createdOn,
      metadata: { patient: { fullName: 'Amaka Okoro' } },
    });

    assert.equal(result.success, false);
  });

  it('carries both sides of a conflict in a sync rejection', () => {
    const rejection = SyncRejection.parse({
      ...envelope,
      createdBy: 'system',
      id: 'sync_rejection:1',
      type: 'sync_rejection',
      entityType: 'patient',
      entityId: patient.id,
      operation: 'patch',
      category: 'conflict',
      reason: 'phone changed on two devices',
      attributedTo: 'staff:one',
      conflicts: [{ column: 'phone', deviceValue: '0801', serverValue: '0802' }],
    });

    assert.equal(rejection.conflicts?.length, 1);
    assert.equal(rejection.resolvedOn, undefined);
  });

  it('refuses an unknown type', () => {
    assert.equal(parseDocument({ ...envelope, id: 'x', type: 'prescription' }).success, false);
  });
});
