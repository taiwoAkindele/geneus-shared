import { Appointment, AuthoritySnapshot, CapabilityDecision, Credential, Handoff, Location, ServiceDefinition,
  ServiceOffering, ServiceSession, Staff, StaffAssignment, Unit, staffPermissions,
  type AuthorityProof, type AuthorizationContext, type FacilityRecords } from '../src/index.ts';

export const NOW = Date.parse('2026-10-29T10:00:00Z');
export const envelope = { facilityId: 'TEST-PHC', createdBy: 'staff:reviewer', createdOn: '2026-10-29T08:00:00Z', deviceId: 'device:test' };
export const patientId = 'TEST-PHC-000047-K2';
export const worker = Staff.parse({ ...envelope, type: 'staff', id: 'staff:nurse', staffId: 'staff:nurse', fullName: 'Example Nurse', role: 'nurse' });
export const reviewer = Staff.parse({ ...worker, id: 'staff:reviewer', staffId: 'staff:reviewer', role: 'facility_admin', fullName: 'Example Reviewer' });
// Deliberately different legacy id/unitId.
export const unit = Unit.parse({ ...envelope, type: 'unit', id: 'unit:outpatient', unitId: 'OPD', name: 'Outpatient' });
export const location = Location.parse({ ...envelope, type: 'location', id: 'location:consulting', name: 'Consulting room', kind: 'room', unitId: 'OPD', capacity: 2 });
export const definition = ServiceDefinition.parse({ ...envelope, type: 'service_definition', id: 'service:consultation', name: 'Consultation', category: 'consultation', concept: { system: 'urn:geneus:local-service', code: 'consultation', label: 'Consultation' } });
export const offering = ServiceOffering.parse({ ...envelope, type: 'service_offering', id: 'offering:outpatient', name: 'Outpatient consultation', serviceDefinitionId: definition.id, unitId: unit.id, locationIds: [location.id], delivery: 'physical', requiredActions: ['assess'], intakePolicy: 'both', timeZone: 'Africa/Lagos', configuration: 'active' });
export const credential = Credential.parse({ ...envelope, type: 'credential', id: 'credential:one:v1', credentialId: 'credential:one', version: 1, staffId: worker.staffId,
  kind: 'registration', issuer: 'Synthetic professional body', label: 'Synthetic evidence', evidenceReference: 'evidence:synthetic', issuedOn: '2026-01-01', validThrough: '2026-12-31', timeZone: 'Africa/Lagos', verification: 'verified', checkedBy: reviewer.staffId, checkedOn: envelope.createdOn });
export const decision = CapabilityDecision.parse({ ...envelope, type: 'capability_decision', id: 'capability:one:v1', capabilityId: 'capability:one', version: 1,
  staffId: worker.staffId, scope: { kind: 'offerings', offeringIds: [offering.id], actions: ['assess', 'diagnose', 'prescribe'] }, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-30T23:00:00Z', decision: 'approve', credentialRevisionIds: [credential.id], reason: 'Independent synthetic evidence review' });
export const assignment = StaffAssignment.parse({ ...envelope, type: 'staff_assignment', id: 'assignment:one:v1', assignmentId: 'assignment:one', version: 1,
  staffId: worker.staffId, offeringId: offering.id, locationIds: [location.id], startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-30T23:00:00Z', duty: 'member', status: 'active', requiredActions: ['assess'] });
export const session = ServiceSession.parse({ ...envelope, type: 'service_session', id: 'session:one:v1', sessionId: 'session:one', version: 1,
  offeringId: offering.id, startsAt: '2026-10-29T09:00:00Z', endsAt: '2026-10-29T17:00:00Z', timeZone: 'Africa/Lagos', status: 'published',
  participants: [{ staffId: worker.staffId, assignmentId: assignment.assignmentId, commitment: 'exclusive' }], resources: [{ locationId: location.id, mode: 'pooled', units: 1 }], maxAppointments: 3 });
export const data: FacilityRecords = { units: [unit], locations: [location], definitions: [definition], offerings: [offering], staff: [worker, reviewer], assignments: [assignment], sessions: [session], credentials: [credential] };
export const appointment = Appointment.parse({ ...envelope, type: 'appointment', id: 'appointment:one', patientId, reason: 'Synthetic consultation', scheduledFor: '2026-10-29T10:00:00Z', status: 'scheduled',
  allocation: { offeringId: offering.id, sessionId: session.sessionId, assignmentId: assignment.assignmentId, staffId: worker.staffId, endsAt: '2026-10-29T10:30:00Z', locations: [{ locationId: location.id, units: 1 }] } });
export const handoff = Handoff.parse({ ...envelope, type: 'handoff', id: 'handoff:one', patientId, fromUnitId: 'unit:reception', toUnitId: 'OPD', instruction: 'Synthetic clinical instruction', status: 'pending' });
export const contextFor = (staff: Staff): AuthorizationContext => ({ userId: staff.staffId, facilityId: staff.facilityId, deviceId: 'device:test', role: staff.role, permissions: staffPermissions(staff), policyVersion: 10, lastServerContactOn: envelope.createdOn });
export const proofFor = (staff: Staff = worker): AuthorityProof => ({ currentRevision: 1, signatureVerified: true, snapshot: AuthoritySnapshot.parse({ ...envelope,
  type: 'authority_snapshot', id: `authority:${staff.staffId}:1`, createdBy: 'system', staffId: staff.staffId, revision: 1, policyVersion: 10,
  issuedOn: envelope.createdOn, expiresOn: '2026-11-02T08:00:00Z', grants: [{ capabilityId: decision.capabilityId, decisionId: decision.id,
    scope: decision.scope, startsAt: decision.startsAt, endsAt: decision.endsAt }], sourceDecisionIds: [decision.id], keyId: 'key:test', signature: 'synthetic-signature' }) });
