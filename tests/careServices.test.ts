import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Appointment,
  Encounter,
  Facility,
  FacilityDetailsUpdate,
  VisitType,
} from '../src/documents.ts';
import { ServiceOffering } from '../src/facility.ts';
import { UploadRequest } from '../src/api.ts';
import {
  careServiceOfferings,
  careServiceVisitIssues,
  defaultVisitType,
  isLabTestOffering,
  visitCareServices,
} from '../src/careServices.ts';
import * as contract from '../src/index.ts';

const createdOn = '2026-11-15T08:00:00.000Z';
const envelope = { facilityId: 'TEST', deviceId: 'device:one', createdBy: 'staff:one', createdOn };
const offering = (id: string, patch: Record<string, unknown> = {}) =>
  ServiceOffering.parse({
    ...envelope,
    schemaVersion: 4,
    id,
    type: 'service_offering',
    serviceDefinitionId: `def:${id}`,
    unitId: 'unit:1',
    name: id,
    locationIds: ['loc:1'],
    delivery: 'physical',
    intakePolicy: 'both',
    timeZone: 'Africa/Lagos',
    configuration: 'active',
    ...patch,
  });
const definitions = [
  { id: 'def:hb', investigation: { specimen: 'Blood', department: 'Haematology', aliases: [] } },
  { id: 'def:opd' },
  { id: 'def:anc' },
  { id: 'def:ward' },
  { id: 'def:spec' },
];
const opd = offering('opd', { visitTypes: ['general', 'follow_up'] });
const anc = offering('anc', { visitTypes: ['antenatal'], intakePolicy: 'scheduled' });
const ward = offering('ward', { intakePolicy: 'walk_in' });
const hb = offering('hb', { visitTypes: ['general'] });
const spec = offering('spec', { visitTypes: ['general'], configuration: 'draft' });
const all = [opd, anc, ward, hb, spec];

describe('care services', () => {
  it('keeps offerings saved before visit kinds valid, and VisitType available from both modules', () => {
    assert.deepEqual(offering('old').visitTypes, []);
    assert.equal(contract.VisitType, VisitType);
    assert.ok(!ServiceOffering.safeParse({ ...opd, visitTypes: ['general', 'general'] }).success);
  });

  it('separates care services from lab tests and offers only visit services that accept the arrival', () => {
    assert.ok(isLabTestOffering(hb, definitions));
    assert.deepEqual(
      careServiceOfferings(all, definitions).map((o) => o.id),
      ['opd', 'anc', 'ward', 'spec'],
    );
    assert.deepEqual(
      visitCareServices(all, definitions).map((o) => o.id),
      ['opd', 'anc'],
    );
    assert.deepEqual(
      visitCareServices(all, definitions, 'walk_in').map((o) => o.id),
      ['opd'],
    );
    assert.deepEqual(
      visitCareServices(all, definitions, 'scheduled').map((o) => o.id),
      ['opd', 'anc'],
    );
    assert.equal(defaultVisitType(opd), 'general');
  });

  it('checks a booked care service and the visit kind it records', () => {
    const data = { offerings: all, definitions };
    assert.deepEqual(careServiceVisitIssues({ facilityId: 'TEST' }, data), []);
    assert.deepEqual(
      careServiceVisitIssues(
        { facilityId: 'TEST', offeringId: 'opd', visitType: 'follow_up' },
        data,
      ),
      [],
    );
    assert.match(
      careServiceVisitIssues(
        { facilityId: 'TEST', offeringId: 'opd', visitType: 'antenatal' },
        data,
      )[0],
      /does not record this kind/,
    );
    assert.match(
      careServiceVisitIssues({ facilityId: 'TEST', offeringId: 'hb' }, data)[0],
      /care service of this hospital/,
    );
    assert.match(
      careServiceVisitIssues({ facilityId: 'TEST', offeringId: 'ward' }, data)[0],
      /does not take booked/,
    );
    assert.match(
      careServiceVisitIssues({ facilityId: 'TEST', offeringId: 'spec' }, data)[0],
      /not an active/,
    );
    assert.deepEqual(
      careServiceVisitIssues(
        { facilityId: 'TEST', offeringId: 'spec', visitType: 'general' },
        data,
        { recorded: true },
      ),
      [],
      'care recorded offline is kept after the service is retired',
    );
    assert.match(
      careServiceVisitIssues({ facilityId: 'OTHER', offeringId: 'opd' }, data)[0],
      /care service of this hospital/,
    );
  });

  it('records the care service on bookings and visits, keeping older records valid', () => {
    const booking = {
      ...envelope,
      id: 'booking:1',
      type: 'appointment',
      patientId: 'TEST-000001-K2',
      reason: 'Consultation',
    };
    assert.equal(Appointment.parse(booking).offeringId, undefined);
    assert.equal(
      Appointment.parse({ ...booking, offeringId: 'opd', visitType: 'general' }).offeringId,
      'opd',
    );
    const allocation = { offeringId: 'anc', endsAt: '2026-11-16T10:00:00.000Z' };
    assert.ok(
      !Appointment.safeParse({
        ...booking,
        status: 'scheduled',
        scheduledFor: '2026-11-16T09:00:00.000Z',
        offeringId: 'opd',
        allocation,
      }).success,
      'resources are reserved for the booked service',
    );
    assert.ok(
      Appointment.safeParse({
        ...booking,
        status: 'scheduled',
        scheduledFor: '2026-11-16T09:00:00.000Z',
        offeringId: 'anc',
        allocation,
      }).success,
    );
    assert.equal(
      Encounter.parse({
        ...envelope,
        id: 'enc:1',
        type: 'encounter',
        patientId: 'TEST-000001-K2',
        openedOn: createdOn,
        offeringId: 'opd',
      }).offeringId,
      'opd',
    );
  });

  it('lets a hospital keep its details, never its code', () => {
    const facility = Facility.parse({
      ...envelope,
      id: 'TEST',
      type: 'facility',
      code: 'TEST',
      name: 'Test',
      lga: 'Ikeja',
      state: 'Lagos',
    });
    assert.equal(facility.country, undefined);
    assert.ok(
      Facility.safeParse({
        ...facility,
        country: 'NG',
        currency: 'NGN',
        address: '12 Road',
        phone: '+234 800 000 0000',
      }).success,
    );
    assert.ok(!Facility.safeParse({ ...facility, country: 'Nigeria' }).success);
    const update = {
      name: 'Test',
      level: 'general_hospital',
      state: 'Lagos',
      lga: 'Ikeja',
      country: 'NG',
      currency: 'NGN',
    };
    assert.ok(FacilityDetailsUpdate.safeParse(update).success);
    assert.ok(!FacilityDetailsUpdate.safeParse({ ...update, code: 'OTHER' }).success);
  });

  it('accepts care-service fields only from a client that negotiated them', () => {
    const put = {
      clientId: 1,
      op: 'put',
      table: 'appointment',
      id: 'booking:1',
      data: { offeringId: 'opd' },
    };
    const current = { careServiceVersion: 1, facilityContractVersion: 1, schemaVersion: 5 };
    assert.ok(!UploadRequest.safeParse({ transactionId: null, mutations: [put] }).success);
    assert.ok(
      UploadRequest.safeParse({ ...current, transactionId: null, mutations: [put] }).success,
    );
    assert.ok(
      UploadRequest.safeParse({
        transactionId: null,
        mutations: [{ ...put, data: { reason: 'x' } }],
      }).success,
    );
  });
});
