import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnyDocument, Appointment, AppointmentReservation, CapabilityDecision, ClinicalAuthorityBootstrap, DocType,
  FACILITY_DOCUMENT_POLICY, FACILITY_DOCUMENT_TYPES, RESTRICTED_FACILITY_DOCUMENT_TYPES, FacilityDate, FacilityTimeZone, Location, PractitionerProfile,
  ReviewerDelegation, SCHEMA_BY_TYPE, ServiceOffering, ServiceSession, SessionEvent, Staff, StaffAssignment, Unit,
  WorkOwnershipEvent, appointmentAllocationFingerprint, appointmentAllocationIssues, currentFacilityRevisions,
  effectiveFacilityRevisions, facilityHeadIssues, facilityReferenceIssues, facilityRetirementImpact, facilityRevisionIssues,
  parseDocument, reservationMatchesAppointment, resourceCapacityIssues, sessionConflictIssues, sessionEventIssues,
  sessionRosterIssues, sessionBookingIssues, sessionEventHeadIssues, unitHierarchyIssues, unitIsRoutable, workOwnershipHeadIssues, workOwnershipIssues, workOwnershipReferenceIssues,
  RosterShift } from '../src/index.ts';
import { NOW, appointment, assignment, credential, data, decision, envelope, handoff, location, offering, patientId, session, unit, worker } from './facilityFixtures.ts';

describe('facility contracts and legacy boundaries', () => {
  it('registers every type at both parsing entry points and keeps history readable', () => {
    assert.deepEqual(Object.keys(SCHEMA_BY_TYPE).sort(), [...DocType.options].sort());
    assert.deepEqual(Object.keys(FACILITY_DOCUMENT_POLICY).sort(), [...FACILITY_DOCUMENT_TYPES].sort());
    assert.deepEqual(Object.entries(FACILITY_DOCUMENT_POLICY).filter(([, v]) => v.visibility === 'restricted').map(([key]) => key).sort(), [...RESTRICTED_FACILITY_DOCUMENT_TYPES].sort());
    for (const v of [location, offering, credential, assignment, session, decision]) {
      assert.equal(parseDocument(v).success, true); assert.equal(AnyDocument.safeParse(v).success, true);
      assert.equal(parseDocument({ ...v, schemaVersion: 3 }).success, false);
    }
    assert.equal(Unit.parse({ ...unit, schemaVersion: 3 }).unitId, 'OPD');
    assert.equal(unitIsRoutable(unit), true);
    assert.equal(parseDocument({ type: '__proto__' }).success, false);
    assert.equal(parseDocument({ type: 'constructor' }).success, false);
  });
  it('rejects unknown privileged fields, invalid dates and duplicate/scopeless choices', () => {
    assert.equal(Location.safeParse({ ...location, approvedByAdmin: true }).success, false);
    assert.equal(FacilityDate.safeParse('2026-02-30').success, false);
    assert.equal(FacilityDate.safeParse('2028-02-29').success, true);
    assert.equal(FacilityTimeZone.safeParse('Lagos').success, false);
    assert.equal(FacilityTimeZone.safeParse('+01:00').success, false);
    assert.equal(ServiceOffering.safeParse({ ...offering, requiredActions: ['assess', 'assess'] }).success, false);
    assert.equal(CapabilityDecision.safeParse({ ...decision, scope: { kind: 'offerings', offeringIds: [], actions: ['assess'] } }).success, false);
    assert.equal(Location.safeParse({ ...location, kind: 'bed', capacity: 2 }).success, false);
  });
  it('separates financial, professional, access, location and service identities', () => {
    assert.notEqual(unit.id, unit.unitId);
    assert.equal(PractitionerProfile.safeParse({ ...envelope, type: 'practitioner_profile', id: 'professional:one', staffId: worker.staffId, profession: { system: 'urn:local', code: 'nurse', label: 'Nurse' } }).success, true);
    assert.equal(Staff.safeParse({ ...worker, additionalPermissions: ['clinical_capability:review'] }).success, false);
    assert.equal(ServiceOffering.safeParse({ ...offering, delivery: 'physical', locationIds: [] }).success, false);
    assert.equal(ServiceOffering.parse({ ...offering, delivery: 'mobile', locationIds: [] }).resourceReadiness, 'unassessed');
  });
  it('requires bounded cover and coherent revision identities', () => {
    assert.equal(StaffAssignment.safeParse({ ...assignment, temporaryCover: true, endsAt: undefined }).success, false);
    assert.equal(StaffAssignment.safeParse({ ...assignment, temporaryCover: true, reason: 'Cover for clinic', coveringAssignmentId: assignment.assignmentId }).success, false);
    assert.equal(StaffAssignment.safeParse({ ...assignment, version: 2 }).success, false);
    assert.equal(ClinicalAuthorityBootstrap.safeParse({ ...envelope, type: 'clinical_authority_bootstrap', createdBy: worker.staffId }).success, false);
    assert.equal(ReviewerDelegation.safeParse({ ...envelope, type: 'reviewer_delegation', staffId: envelope.createdBy }).success, false);
  });
});

describe('facility references, history and retirement', () => {
  it('checks same-facility references, routing and active ancestors with legacy aliases', () => {
    for (const v of [location, offering, assignment, session, decision]) assert.deepEqual(facilityReferenceIssues(v, data), [], v.type);
    assert.ok(facilityReferenceIssues({ ...offering, facilityId: 'OTHER-PHC' }, data).length);
    assert.ok(facilityReferenceIssues(offering, { ...data, locations: [{ ...location, kind: 'virtual' }] }).length);
    assert.ok(facilityReferenceIssues(offering, { ...data, units: [{ ...unit, kind: 'department' }] }).length);
    const child = Unit.parse({ ...unit, id: 'unit:child', unitId: 'CHILD', name: 'Child', parentId: 'OPD' });
    assert.deepEqual(unitHierarchyIssues(child, [unit]), []);
    assert.ok(unitHierarchyIssues(child, [{ ...unit, active: false }]).length);
    assert.ok(unitHierarchyIssues({ ...unit, parentId: 'CHILD' }, [unit, child]).length);
    assert.ok(unitHierarchyIssues({ ...child, parentId: undefined, name: '  OUTPATIENT ' }, [unit]).length);
    assert.ok(unitHierarchyIssues({ ...child, unitId: unit.id }, [unit]).length);
  });
  it('retains competing heads and rejects a stale predecessor under a serialized write', () => {
    const v2 = StaffAssignment.parse({ ...assignment, id: 'assignment:one:v2', previousId: assignment.id, version: 2, reason: 'Change duty' });
    const fork = { ...v2, id: 'assignment:fork:v2', createdOn: '2030-01-01T00:00:00Z' };
    assert.deepEqual(currentFacilityRevisions([assignment, v2, fork]).map((v) => v.id).sort(), [v2.id, fork.id].sort());
    assert.deepEqual(facilityHeadIssues(v2, [assignment]), []);
    assert.ok(facilityHeadIssues(v2, [v2]).length);
    assert.ok(facilityHeadIssues(assignment, [assignment]).length);
    assert.ok(facilityRevisionIssues({ ...v2, staffId: 'staff:other' }, assignment).length);
    assert.ok(facilityRevisionIssues({ ...v2, facilityId: 'OTHER' }, assignment).length);
    const future = { ...v2, startsAt: '2026-11-01T00:00:00Z' };
    assert.equal(effectiveFacilityRevisions([assignment, future], NOW)[0].id, assignment.id);
    assert.equal(effectiveFacilityRevisions([assignment, future], Date.parse(future.startsAt))[0].id, future.id);
  });
  it('cannot approve against expired or superseded evidence, but allows an urgent revocation', () => {
    assert.ok(facilityReferenceIssues({ ...decision, endsAt: undefined }, data).length);
    const withdrawn = { ...credential, id: 'credential:one:v2', version: 2, previousId: credential.id, verification: 'withdrawn' as const, reason: 'Withdrawn review' };
    assert.ok(facilityReferenceIssues(decision, { ...data, credentials: [credential, withdrawn] }).length);
    const revoke = CapabilityDecision.parse({ ...decision, id: 'capability:one:v2', version: 2, previousId: decision.id, decision: 'revoke', credentialRevisionIds: [] });
    assert.deepEqual(facilityReferenceIssues(revoke, { ...data, credentials: [withdrawn], staff: data.staff.map((s) => ({ ...s, active: false })), offerings: [{ ...offering, configuration: 'retired' }] }), []);
  });
  it('previews future work without mutating bookings, sessions, money or instructions', () => {
    const before = JSON.stringify({ data, appointment, handoff });
    const impact = facilityRetirementImpact({ type: 'service_offering', id: offering.id, facilityId: offering.facilityId }, { ...data, appointments: [appointment], handoffs: [handoff] }, NOW);
    for (const id of [assignment.id, session.id, appointment.id, handoff.id]) assert.ok(impact.some((r) => r.id === id));
    assert.equal(JSON.stringify({ data, appointment, handoff }), before);
    assert.deepEqual(facilityRetirementImpact({ type: 'service_offering', id: offering.id, facilityId: 'OTHER' }, data, NOW), []);
  });
});

describe('sessions, resources and reservations', () => {
  it('supports overnight/multiple windows and keeps sign-in separate from operational intake', () => {
    const overnight = ServiceSession.parse({ ...session, startsAt: '2026-10-29T22:00:00+01:00', endsAt: '2026-10-30T06:00:00+01:00' });
    const roster = RosterShift.parse({ ...envelope, type: 'roster_shift', id: 'roster:second-window', staffId: worker.staffId, startsAt: overnight.startsAt, endsAt: overnight.endsAt });
    assert.deepEqual(sessionRosterIssues({ ...overnight, rosterShiftIds: [roster.id] }, [roster]), []);
    assert.ok(sessionRosterIssues({ ...overnight, rosterShiftIds: [roster.id] }, [{ ...roster, endsAt: '2026-10-30T05:00:00+01:00' }]).length);
    assert.ok(facilityReferenceIssues({ ...session, endsAt: '2026-12-10T00:00:00Z' }, data).length);
    const open = SessionEvent.parse({ ...envelope, type: 'session_event', id: 'intake:open', offeringId: offering.id, action: 'open', observedOn: envelope.createdOn });
    const pause = SessionEvent.parse({ ...open, id: 'intake:pause', previousId: open.id, action: 'pause', reason: 'Short pause' });
    assert.deepEqual(sessionEventIssues(pause, open), []);
    assert.ok(sessionEventIssues({ ...pause, action: 'resume' }, open).length);
    assert.ok(sessionEventIssues({ ...pause, offeringId: 'offering:other' }, open).length);
    assert.ok(sessionEventHeadIssues(pause, [pause]).length);
    assert.equal(worker.loginAccess, undefined);
  });
  it('finds aggregate pooled conflicts, respects boundaries and avoids false sums over disjoint intervals', () => {
    const resource = [{ locationId: location.id, mode: 'pooled' as const, units: 1 }];
    const interval = (start: string, end: string) => ({ startsAt: `2026-10-29T${start}:00Z`, endsAt: `2026-10-29T${end}:00Z`, resources: resource });
    const candidate = interval('09:00', '17:00');
    assert.ok(resourceCapacityIssues(candidate, [interval('10:00', '12:00'), interval('11:00', '13:00')], [location], location.facilityId).length);
    assert.deepEqual(resourceCapacityIssues(candidate, [interval('10:00', '11:00'), interval('11:00', '12:00')], [location], location.facilityId), []);
    assert.ok(resourceCapacityIssues(candidate, [{ ...interval('10:00', '11:00'), resources: [{ ...resource[0], mode: 'exclusive' }] }], [location], location.facilityId).length);
    assert.ok(resourceCapacityIssues(candidate, [], [{ ...location, capacity: undefined }], location.facilityId).length);
  });
  it('prevents simultaneous exclusive practitioner coverage but permits explicit on-call coverage', () => {
    const peer = { ...session, id: 'session:two:v1', sessionId: 'session:two', resources: [] };
    assert.ok(sessionConflictIssues(session, [peer], data.locations).some((s) => s.includes('Worker')));
    const onCall = { ...peer, participants: peer.participants.map((p) => ({ ...p, commitment: 'on_call' as const })) };
    assert.deepEqual(sessionConflictIssues(session, [onCall], data.locations), []);
    assert.deepEqual(sessionConflictIssues(session, [{ ...peer, startsAt: session.endsAt, endsAt: '2026-10-29T18:00:00Z' }], data.locations), []);
  });
  it('checks booking assignment, capacity, duration and future accepted conflicts', () => {
    assert.deepEqual(appointmentAllocationIssues(appointment, data), []);
    assert.ok(appointmentAllocationIssues(appointment, data, [{ ...appointment, id: 'appointment:other' }]).some((s) => s.includes('Practitioner')));
    assert.ok(appointmentAllocationIssues(appointment, { ...data, sessions: [{ ...session, status: 'cancelled' }] }).length);
    assert.ok(appointmentAllocationIssues({ ...appointment, allocation: { ...appointment.allocation!, endsAt: '2026-10-29T18:00:00Z' } }, data).length);
    assert.equal(Appointment.safeParse({ ...appointment, allocation: { ...appointment.allocation!, endsAt: appointment.scheduledFor } }).success, false);
    assert.equal(Appointment.safeParse({ ...appointment, allocation: { ...appointment.allocation!, assignmentId: undefined } }).success, false);
    const freePool = { ...appointment, allocation: { ...appointment.allocation!, staffId: undefined, assignmentId: undefined } };
    assert.ok(appointmentAllocationIssues(freePool, { ...data, sessions: [{ ...session, maxAppointments: 1 }] }, [{ ...freePool, id: 'appointment:other' }]).some((s) => s.includes('capacity')));
  });
  it('ties server confirmation to the exact current proposal, independent of ISO formatting', () => {
    const reservation = AppointmentReservation.parse({ ...envelope, type: 'appointment_reservation', id: 'reservation:one', createdBy: 'system', appointmentId: appointment.id,
      patientId, offeringId: offering.id, allocationFingerprint: appointmentAllocationFingerprint(appointment), status: 'accepted', revision: 1 });
    assert.equal(reservationMatchesAppointment(reservation, appointment), true);
    assert.equal(reservationMatchesAppointment(reservation, { ...appointment, scheduledFor: '2026-10-29T11:00:00+01:00' }), true);
    assert.equal(reservationMatchesAppointment(reservation, { ...appointment, allocation: { ...appointment.allocation!, endsAt: '2026-10-29T10:45:00Z' } }), false);
    assert.equal(reservationMatchesAppointment({ ...reservation, facilityId: 'OTHER' }, appointment), false);
    assert.equal(reservationMatchesAppointment({ ...reservation, status: 'released' }, appointment), false);
  });
  it('keeps bookings within the parent session quota and protects reservations when replanning', () => {
    const pool = { ...appointment, allocation: { ...appointment.allocation!, staffId: undefined, assignmentId: undefined } };
    const peer = { ...pool, id: 'appointment:peer' };
    assert.ok(appointmentAllocationIssues(pool, data, [peer]).some((s) => s.includes('capacity')));
    assert.deepEqual(sessionBookingIssues(session, [appointment], data.locations, NOW), []);
    assert.ok(sessionBookingIssues({ ...session, status: 'cancelled' }, [appointment], data.locations, NOW).length);
    assert.ok(sessionBookingIssues({ ...session, endsAt: '2026-10-29T10:15:00Z' }, [appointment], data.locations, NOW).length);
    const exclusive = { ...session, resources: [{ ...session.resources[0], mode: 'exclusive' as const }] };
    const direct = { ...pool, allocation: { ...pool.allocation, sessionId: undefined } };
    assert.ok(appointmentAllocationIssues(direct, { ...data, sessions: [exclusive] }).some((s) => s.includes('capacity')));
    assert.ok(sessionConflictIssues(exclusive, [], data.locations, [direct]).some((s) => s.includes('capacity')));
    assert.ok(appointmentAllocationIssues(pool, { ...data, sessions: [{ ...session, resources: [] }] }).some((s) => s.includes('parent session')));
  });
});

describe('causal work ownership and accepted handover', () => {
  const claim = WorkOwnershipEvent.parse({ ...envelope, type: 'work_ownership_event', id: 'work:claim', createdBy: worker.staffId,
    sourceType: 'handoff', sourceId: handoff.id, patientId, offeringId: offering.id, action: 'claim', ownerStaffId: worker.staffId });
  const offer = WorkOwnershipEvent.parse({ ...claim, id: 'work:offer', previousId: claim.id, action: 'offer_transfer', recipientStaffId: 'staff:other', reason: 'Next session' });
  it('retains the owner until the named recipient accepts and blocks premature/foreign acceptance', () => {
    assert.deepEqual(workOwnershipIssues(claim, handoff), []);
    assert.deepEqual(workOwnershipIssues(offer, handoff, claim), []);
    assert.equal(offer.ownerStaffId, worker.staffId);
    const accept = WorkOwnershipEvent.parse({ ...claim, id: 'work:accept', createdBy: 'staff:other', ownerStaffId: 'staff:other', previousId: offer.id, action: 'accept_transfer', reason: 'Accepted work' });
    assert.deepEqual(workOwnershipIssues(accept, handoff, offer), []);
    assert.ok(workOwnershipIssues({ ...accept, createdBy: 'staff:stranger' }, handoff, offer).length);
    assert.ok(workOwnershipIssues({ ...accept, previousId: claim.id }, handoff, claim).length);
    assert.equal(handoff.status, 'pending');
  });
  it('retains declined/released work honestly and checks current heads across service offers', () => {
    const decline = { ...claim, id: 'work:decline', previousId: offer.id, createdBy: 'staff:other', action: 'decline_transfer' as const, reason: 'Unavailable' };
    assert.deepEqual(workOwnershipIssues(decline, handoff, offer), []);
    assert.ok(workOwnershipIssues({ ...decline, ownerStaffId: 'staff:other' }, handoff, offer).length);
    const release = { ...claim, id: 'work:release', previousId: claim.id, action: 'release' as const, ownerStaffId: undefined, reason: 'Return to service' };
    assert.deepEqual(workOwnershipIssues(release, handoff, claim), []);
    assert.ok(workOwnershipIssues({ ...claim, previousId: claim.id }, handoff, claim).length);
    assert.ok(workOwnershipHeadIssues({ ...claim, offeringId: 'offering:other' }, [claim]).length);
    assert.ok(workOwnershipIssues(claim, { ...handoff, patientId: 'TEST-PHC-000048-K3' }).length);
    assert.ok(workOwnershipIssues(claim, { ...handoff, status: 'done' }).length);
  });
  it('validates the destination, effective membership and receiver before a transfer', () => {
    assert.deepEqual(workOwnershipReferenceIssues(claim, handoff, data, NOW), []);
    assert.ok(workOwnershipReferenceIssues(offer, handoff, data, NOW).length);
    assert.ok(workOwnershipReferenceIssues(claim, { ...handoff, toUnitId: 'unit:foreign' }, data, NOW).length);
    assert.ok(workOwnershipReferenceIssues(claim, handoff, { ...data, assignments: [] }, NOW).length);
    const other = Staff.parse({ ...worker, id: 'staff:other', staffId: 'staff:other' });
    const receiverAssignment = { ...assignment, id: 'assignment:other:v1', assignmentId: 'assignment:other', staffId: other.staffId };
    // Outgoing shift/assignment can end before handover; only the new recipient needs current eligibility.
    assert.deepEqual(workOwnershipReferenceIssues(offer, handoff, { ...data, staff: [...data.staff, other], assignments: [receiverAssignment] }, NOW), []);
  });
});
