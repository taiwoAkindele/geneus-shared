/** Pure, shared invariants. Callers supply authoritative/current records, not arbitrary client claims. */
import type { Appointment, BillingDepartment, Handoff, RosterShift, Staff, Unit } from './documents.ts';
import { credentialSupportsInterval } from './facilityAuthorization.ts';
import type {
  AppointmentReservation, CapabilityDecision, ClinicalAuthorityBootstrap, Credential, Location, PractitionerProfile, ReviewerDelegation,
  ServiceDefinition, ServiceOffering, ServiceSession, SessionEvent, StaffAssignment, WorkOwnershipEvent,
} from './facility.ts';
import { intervalContains, intervalsOverlap } from './facilityTypes.ts';

export type FacilityRecords = {
  units: readonly Unit[]; locations: readonly Location[]; staff: readonly Staff[];
  definitions: readonly ServiceDefinition[]; offerings: readonly ServiceOffering[];
  assignments: readonly StaffAssignment[]; sessions: readonly ServiceSession[];
  credentials: readonly Credential[];
};
export const organizationKind = (unit: Unit) => unit.kind ?? 'unit';
export const unitIsRoutable = (unit: Unit): boolean => unit.active && organizationKind(unit) === 'unit' && (unit.routingEnabled ?? true);
export const billingOrganizationIssues = (department: BillingDepartment, units: readonly Unit[]): string[] => {
  if (!department.organizationUnitId) return [];
  const matches = units.filter((u) => u.facilityId === department.facilityId && [u.id, u.unitId].includes(department.organizationUnitId!));
  return matches.length === 1 && (!department.active || matches[0].active) ? [] : ['Billing mapping requires an unambiguous organization in this facility, active for new collection'];
};
export const normalizedFacilityName = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Resolve legacy aliases without treating unitId and id as interchangeable identities. */
export const unitHierarchyIssues = (v: Unit, units: readonly Unit[]): string[] => {
  const records = [...units.filter((u) => u.id !== v.id || u.facilityId !== v.facilityId), v].filter((u) => u.facilityId === v.facilityId);
  const issues: string[] = [];
  const normalized = records.map((unit) => {
    if (!unit.parentId) return unit;
    const parents = records.filter((u) => u.id === unit.parentId || u.unitId === unit.parentId);
    if (parents.length !== 1) issues.push('Parent unit identity is missing or ambiguous');
    return { ...unit, parentId: parents.length === 1 ? parents[0].id : unit.parentId };
  });
  if (records.some((u) => u.id !== v.id && (u.unitId === v.unitId || u.unitId === v.id || u.id === v.unitId))) issues.push('Organization identities collide with an existing unit alias');
  const candidate = normalized.find((u) => u.id === v.id)!;
  return [...issues, ...hierarchyIssues(candidate, normalized)];
};

type TreeNode = { id: string; facilityId: string; name: string; parentId?: string; active: boolean };
export const hierarchyIssues = (candidate: TreeNode, records: readonly TreeNode[]): string[] => {
  const issues: string[] = [];
  if (records.some((r) => r.id !== candidate.id && r.facilityId === candidate.facilityId && r.active && candidate.active
    && r.parentId === candidate.parentId && normalizedFacilityName(r.name) === normalizedFacilityName(candidate.name))) issues.push('An active sibling already has this name');
  const seen = new Set([candidate.id]); let parentId = candidate.parentId;
  while (parentId) {
    if (seen.has(parentId)) { issues.push('A hierarchy cannot contain a cycle'); break; }
    seen.add(parentId);
    const matches = records.filter((r) => r.id === parentId && r.facilityId === candidate.facilityId);
    if (matches.length !== 1) { issues.push('Parent must exist unambiguously in this facility'); break; }
    const parent = matches[0];
    if (candidate.active && !parent.active) issues.push('An active record cannot belong to a retired ancestor');
    parentId = parent.parentId;
  }
  return issues;
};

type Versioned = Credential | CapabilityDecision | ClinicalAuthorityBootstrap | ReviewerDelegation | StaffAssignment | ServiceSession;
const streamId = (v: Versioned): string => {
  switch (v.type) {
    case 'clinical_authority_bootstrap': return v.bootstrapId;
    case 'credential': return v.credentialId;
    case 'capability_decision': return v.capabilityId;
    case 'reviewer_delegation': return v.delegationId;
    case 'staff_assignment': return v.assignmentId;
    case 'service_session': return v.sessionId;
  }
};
export const facilityRevisionIssues = (candidate: Versioned, previous: Versioned | undefined): string[] => {
  if (!candidate.previousId) return candidate.version === 1 && !previous ? [] : ['First version cannot replace another record'];
  if (!previous || candidate.previousId !== previous.id || candidate.type !== previous.type || candidate.facilityId !== previous.facilityId
    || streamId(candidate) !== streamId(previous) || candidate.version !== previous.version + 1) return ['Predecessor must be the preceding version of this facility record'];
  if ('staffId' in candidate && 'staffId' in previous && candidate.staffId !== previous.staffId) return ['A revision cannot move a record to another worker'];
  return [];
};
/** Retain forks for reconciliation; never choose the newest wall-clock timestamp. */
export const currentFacilityRevisions = <T extends Versioned>(records: readonly T[]): T[] => {
  const replaced = new Set<string>();
  for (const record of records) {
    const previous = records.find((v) => v.id === record.previousId && v.facilityId === record.facilityId);
    if (previous && !facilityRevisionIssues(record, previous).length) replaced.add(`${previous.facilityId}|${previous.id}`);
  }
  return records.filter((v) => !replaced.has(`${v.facilityId}|${v.id}`));
};
/** Follow causality through scheduled revisions; future changes do not prematurely end current work. */
export const effectiveFacilityRevisions = <T extends CapabilityDecision | ClinicalAuthorityBootstrap | ReviewerDelegation | StaffAssignment | ServiceSession>(records: readonly T[], at: number): T[] => {
  if (!Number.isFinite(at)) return [];
  const result = new Map<string, T>();
  for (const head of currentFacilityRevisions(records)) {
    let value: T | undefined = head; const visited = new Set<string>();
    while (value && Date.parse(value.startsAt) > at) {
      if (visited.has(value.id)) { value = undefined; break; }
      visited.add(value.id);
      const next: T | undefined = records.find((p) => p.id === value!.previousId && p.facilityId === head.facilityId && p.type === head.type && streamId(p) === streamId(head));
      value = next;
    }
    if (value) result.set(`${value.facilityId}|${value.id}`, value);
  }
  return [...result.values()];
};
/** Run under a serialized stream lock/unique-head constraint, after transport deduplication. */
export const facilityHeadIssues = (v: Versioned, currentHeads: readonly Versioned[]): string[] => {
  const heads = currentHeads.filter((h) => h.facilityId === v.facilityId && h.type === v.type && streamId(h) === streamId(v));
  if (!v.previousId) return heads.length ? ['This record stream already has an accepted head'] : [];
  return heads.length === 1 && heads[0].id === v.previousId ? facilityRevisionIssues(v, heads[0]) : ['Predecessor is not the sole current accepted head; reconcile this proposal'];
};

type ReferenceRecord = Location | PractitionerProfile | ServiceOffering | StaffAssignment | ServiceSession | Credential | CapabilityDecision | ReviewerDelegation | ClinicalAuthorityBootstrap;
export const facilityReferenceIssues = (v: ReferenceRecord, data: FacilityRecords): string[] => {
  const issues: string[] = [];
  const staff = (id: string, active = true) => {
    const matches = data.staff.filter((s) => s.facilityId === v.facilityId && (s.id === id || s.staffId === id));
    if (matches.length !== 1 || (active && !matches[0].active)) issues.push('Worker must be an active member of this facility');
  };
  const unit = (id: string, active = true) => {
    const matches = data.units.filter((u) => u.facilityId === v.facilityId && (u.id === id || u.unitId === id));
    if (matches.length !== 1 || (active && !matches[0].active)) issues.push('Organization must exist unambiguously and be active in this facility');
  };
  const locations = (ids: readonly string[], active = true) => ids.forEach((id) => {
    const location = data.locations.find((l) => l.id === id && l.facilityId === v.facilityId);
    if (!location || (active && !location.active)) issues.push('Location must belong to this facility and be active');
  });
  switch (v.type) {
    case 'reviewer_delegation':
    case 'clinical_authority_bootstrap':
      staff(v.staffId, v.decision === 'approve');
      for (const scope of v.scopes) if (scope.kind === 'offerings') for (const id of scope.offeringIds) {
        if (!data.offerings.some((o) => o.id === id && o.facilityId === v.facilityId && (v.decision !== 'approve' || o.configuration === 'active'))) issues.push('Reviewer scope must reference an offering in this facility, active for approval');
      }
      break;
    case 'location':
      issues.push(...hierarchyIssues(v, data.locations)); if (v.unitId) unit(v.unitId, v.active);
      if (data.locations.some((l) => l.id === v.parentId && l.facilityId === v.facilityId && l.kind === 'bed')) issues.push('A bed cannot contain another location');
      break;
    case 'practitioner_profile': staff(v.staffId, v.active); break;
    case 'credential': staff(v.staffId, false); break;
    case 'capability_decision':
      staff(v.staffId, ['approve', 'restrict'].includes(v.decision));
      if (v.supervisorId) staff(v.supervisorId, ['approve', 'restrict'].includes(v.decision));
      for (const id of ['approve', 'restrict'].includes(v.decision) ? v.credentialRevisionIds : []) {
        const credential = data.credentials.find((c) => c.id === id && c.staffId === v.staffId && c.facilityId === v.facilityId);
        const heads = credential && currentFacilityRevisions(data.credentials).filter((c) => c.credentialId === credential.credentialId && c.facilityId === v.facilityId);
        if (!credential || !heads || heads.length !== 1 || heads[0].id !== credential.id || !credentialSupportsInterval(credential, v)) issues.push('Capability evidence must be current, verified and valid for the complete approval interval');
      }
      if (v.scope.kind === 'offerings') for (const id of v.scope.offeringIds) {
        if (!data.offerings.some((o) => o.id === id && o.facilityId === v.facilityId && (!['approve', 'restrict'].includes(v.decision) || o.configuration === 'active'))) issues.push('Clinical scope must reference an offering in this facility, active for approval');
      }
      break;
    case 'service_offering': {
      const active = v.configuration === 'active'; unit(v.unitId, active); locations(v.locationIds, active);
      if (v.delivery === 'physical' && data.locations.some((l) => l.facilityId === v.facilityId && v.locationIds.includes(l.id) && ['virtual', 'mobile'].includes(l.kind))) issues.push('A physical service needs a physical delivery location');
      const definition = data.definitions.find((d) => d.id === v.serviceDefinitionId && d.facilityId === v.facilityId);
      if (!definition || (active && !definition.active)) issues.push('Service definition must exist and be active for activation');
      const owner = data.units.find((u) => u.facilityId === v.facilityId && (u.id === v.unitId || u.unitId === v.unitId));
      if (active && owner && !unitIsRoutable(owner)) issues.push('An active offering needs a routable service unit');
      break;
    }
    case 'staff_assignment': {
      staff(v.staffId, v.status === 'active'); if (v.supervisorId) staff(v.supervisorId);
      const offering = data.offerings.find((o) => o.id === v.offeringId && o.facilityId === v.facilityId);
      if (!offering || (v.status === 'active' && offering.configuration !== 'active')) issues.push('Assignment requires an active offering in the same facility');
      locations(v.locationIds, v.status === 'active');
      if (offering && v.locationIds.some((id) => !offering.locationIds.includes(id))) issues.push('Assignment locations must be offered by the service');
      if (v.coveringAssignmentId) {
        const cover = currentFacilityRevisions(data.assignments).filter((a) => a.assignmentId === v.coveringAssignmentId && a.facilityId === v.facilityId);
        if (cover.length !== 1 || cover[0].offeringId !== v.offeringId || cover[0].staffId === v.staffId) issues.push('Temporary cover must reference another worker in this service');
      }
      break;
    }
    case 'service_session': {
      const offering = data.offerings.find((o) => o.id === v.offeringId && o.facilityId === v.facilityId);
      if (!offering || (v.status === 'published' && offering.configuration !== 'active')) issues.push('Published session requires an active offering');
      for (const participant of v.participants) {
        staff(participant.staffId, v.status === 'published');
        const matches = effectiveFacilityRevisions(data.assignments, Date.parse(v.startsAt)).filter((a) => a.assignmentId === participant.assignmentId && a.facilityId === v.facilityId);
        const a = matches.length === 1 ? matches[0] : undefined;
        if (!a || a.staffId !== participant.staffId || a.offeringId !== v.offeringId || a.status !== 'active'
          || !intervalContains(a, Date.parse(v.startsAt)) || (a.endsAt && Date.parse(v.endsAt) > Date.parse(a.endsAt))) issues.push('Participant needs one effective assignment covering the complete session');
      }
      locations(v.resources.map((r) => r.locationId), v.status === 'published');
      if (offering && v.resources.some((r) => !offering.locationIds.includes(r.locationId))) issues.push('Session resources must belong to this offering');
      break;
    }
  }
  return issues;
};

/** Peak concurrent use, not the sum of every interval overlapping a long session. */
export const resourceCapacityIssues = (
  candidate: { startsAt: string; endsAt: string; resources: readonly { locationId: string; mode: 'exclusive' | 'pooled'; units: number }[] },
  peers: readonly { startsAt: string; endsAt: string; resources: readonly { locationId: string; mode: 'exclusive' | 'pooled'; units: number }[] }[],
  locations: readonly Location[], facilityId: string,
): string[] => {
  const issues: string[] = [];
  for (const resource of candidate.resources) {
    const location = locations.find((l) => l.id === resource.locationId && l.facilityId === facilityId && l.active);
    if (!location || (resource.mode === 'pooled' && !location.capacity)) { issues.push('Resource capacity is unknown or location unavailable'); continue; }
    const capacity = location.capacity ?? 1;
    const points: { at: number; change: number }[] = [];
    for (const interval of [candidate, ...peers]) {
      const r = interval.resources.find((r) => r.locationId === resource.locationId);
      if (!r || !intervalsOverlap(candidate, interval)) continue;
      if (r.units > capacity) issues.push('Requested units exceed location capacity');
      const units = r.mode === 'exclusive' ? capacity : r.units;
      points.push({ at: Math.max(Date.parse(interval.startsAt), Date.parse(candidate.startsAt)), change: units });
      points.push({ at: Math.min(Date.parse(interval.endsAt), Date.parse(candidate.endsAt)), change: -units });
    }
    let inUse = 0;
    for (const point of points.sort((a, b) => a.at - b.at || a.change - b.change)) {
      inUse += point.change;
      if (inUse > capacity) { issues.push('Location has conflicting reserved capacity'); break; }
    }
  }
  return issues;
};
export const sessionConflictIssues = (v: ServiceSession, acceptedSessions: readonly ServiceSession[], locations: readonly Location[], acceptedAppointments: readonly Appointment[] = []): string[] => {
  if (v.status !== 'published') return [];
  const peers = currentFacilityRevisions(acceptedSessions).filter((s) => s.facilityId === v.facilityId && s.sessionId !== v.sessionId && s.status === 'published' && intervalsOverlap(v, s));
  const published = currentFacilityRevisions(acceptedSessions).filter((s) => s.facilityId === v.facilityId && s.status === 'published');
  const rootBookings = acceptedAppointments.filter((a) => a.facilityId === v.facilityId && a.allocation && a.scheduledFor
    && !['cancelled', 'no_show'].includes(a.attendance ?? 'booked') && a.allocation.sessionId !== v.sessionId
    && !published.some((s) => s.sessionId === a.allocation!.sessionId));
  const issues = resourceCapacityIssues(v, [...peers, ...rootBookings.map((a) => ({ startsAt: a.scheduledFor!, endsAt: a.allocation!.endsAt,
    resources: a.allocation!.locations.map((r) => ({ ...r, mode: 'pooled' as const })) }))], locations, v.facilityId);
  for (const person of v.participants) for (const s of peers) {
    const other = s.participants.find((p) => p.staffId === person.staffId);
    if (other && person.commitment !== 'on_call' && other.commitment !== 'on_call'
      && (person.commitment === 'exclusive' || other.commitment === 'exclusive')) issues.push('Worker has another exclusive session commitment');
  }
  return issues;
};

export const sessionEventIssues = (v: SessionEvent, previous?: SessionEvent): string[] => {
  if (!previous) return !v.previousId && v.action === 'open' ? [] : ['Open intake before changing its state'];
  if (v.previousId !== previous.id || v.facilityId !== previous.facilityId || v.offeringId !== previous.offeringId || v.sessionId !== previous.sessionId) return ['Intake events must continue the same service/session'];
  const allowed: Record<SessionEvent['action'], readonly SessionEvent['action'][]> = { open: ['pause', 'close'], pause: ['resume', 'close'], resume: ['pause', 'close'], close: ['open'] };
  return allowed[previous.action].includes(v.action) ? [] : ['Invalid intake transition'];
};
export const sessionEventHeadIssues = (v: SessionEvent, heads: readonly SessionEvent[]): string[] => {
  const same = heads.filter((h) => h.facilityId === v.facilityId && h.offeringId === v.offeringId && h.sessionId === v.sessionId);
  return !v.previousId && !same.length || same.length === 1 && same[0].id === v.previousId ? [] : ['Intake state changed; reconcile its current accepted head'];
};
/** Replanning must explicitly resolve affected future bookings; cancelling a session never cancels them silently. */
export const sessionBookingIssues = (session: ServiceSession, acceptedAppointments: readonly Appointment[], locations: readonly Location[], now: number): string[] => {
  const children = acceptedAppointments.filter((a) => a.facilityId === session.facilityId && a.allocation?.sessionId === session.sessionId
    && !['cancelled', 'no_show'].includes(a.attendance ?? 'booked'));
  const issues: string[] = [];
  if (session.maxAppointments && children.length > session.maxAppointments) issues.push('Existing reservations exceed the proposed session capacity');
  const future = children.filter((a) => Date.parse(a.allocation!.endsAt) > now);
  const quotas = locations.map((l) => {
    const r = session.resources.find((r) => r.locationId === l.id);
    return r ? { ...l, capacity: r.mode === 'exclusive' ? l.capacity ?? 1 : r.units } : l;
  });
  const claimFor = (a: Appointment) => ({ startsAt: a.scheduledFor!, endsAt: a.allocation!.endsAt,
    resources: a.allocation!.locations.map((r) => ({ ...r, mode: 'pooled' as const })) });
  for (const a of future) {
    const allocation = a.allocation!;
    if (session.status !== 'published' || allocation.offeringId !== session.offeringId || !a.scheduledFor || !intervalContains(session, Date.parse(a.scheduledFor))
      || Date.parse(allocation.endsAt) > Date.parse(session.endsAt) || allocation.staffId && !session.participants.some((p) => p.staffId === allocation.staffId && p.assignmentId === allocation.assignmentId)
      || allocation.locations.some((r) => !session.resources.some((resource) => resource.locationId === r.locationId))) issues.push('Resolve an affected booking before changing/cancelling the session');
    if (a.scheduledFor) issues.push(...resourceCapacityIssues(claimFor(a), future.filter((p) => p.id !== a.id && p.scheduledFor).map(claimFor), quotas, session.facilityId));
  }
  return issues;
};
export const workOwnershipIssues = (v: WorkOwnershipEvent, source: Handoff, previous?: WorkOwnershipEvent, canManage = false): string[] => {
  if (source.id !== v.sourceId || source.facilityId !== v.facilityId || source.patientId !== v.patientId) return ['Ownership must reference the same source, patient and facility'];
  if (source.status === 'done' && v.action !== 'release') return ['Completed source work cannot be claimed or transferred'];
  if (!previous) return v.action === 'claim' && !v.previousId ? [] : ['The first event must claim the instruction'];
  if (v.previousId !== previous.id || v.facilityId !== previous.facilityId || v.sourceId !== previous.sourceId
    || v.offeringId !== previous.offeringId || v.patientId !== previous.patientId) return ['Ownership events must continue the same work stream'];
  switch (v.action) {
    case 'claim': return previous.action === 'release' ? [] : ['An owned instruction cannot be claimed again'];
    case 'offer_transfer': return previous.ownerStaffId && previous.action !== 'offer_transfer' && v.ownerStaffId === previous.ownerStaffId
      && (v.createdBy === previous.ownerStaffId || canManage) ? [] : ['Only the current owner/coordinator may offer a transfer'];
    case 'accept_transfer': return previous.action === 'offer_transfer' && previous.recipientStaffId === v.createdBy ? [] : ['Only the offered recipient can accept'];
    case 'decline_transfer': return previous.action === 'offer_transfer' && v.ownerStaffId === previous.ownerStaffId
      && (previous.recipientStaffId === v.createdBy || canManage) ? [] : ['Declining retains the prior owner and needs the recipient/coordinator'];
    case 'release': return previous.ownerStaffId && (previous.ownerStaffId === v.createdBy || canManage) ? [] : ['Only the owner/coordinator may return work to its service'];
  }
};

/** Correlation bytes, not a cryptographic signature. Old confirmations cannot confirm edited proposals. */
export const appointmentAllocationFingerprint = (a: Appointment): string | undefined => a.allocation && a.scheduledFor ? JSON.stringify({
  appointmentId: a.id, facilityId: a.facilityId, patientId: a.patientId, startsAt: Date.parse(a.scheduledFor), endsAt: Date.parse(a.allocation.endsAt),
  offeringId: a.allocation.offeringId, sessionId: a.allocation.sessionId ?? null,
  assignmentId: a.allocation.assignmentId ?? null, staffId: a.allocation.staffId ?? null,
  locations: [...a.allocation.locations].sort((x, y) => x.locationId < y.locationId ? -1 : x.locationId > y.locationId ? 1 : 0).map((r) => ({ locationId: r.locationId, units: r.units })),
}) : undefined;
export const reservationMatchesAppointment = (reservation: AppointmentReservation, appointment: Appointment): boolean =>
  reservation.status === 'accepted' && !['cancelled', 'no_show'].includes(appointment.attendance ?? 'booked')
  && reservation.appointmentId === appointment.id && reservation.facilityId === appointment.facilityId
  && reservation.patientId === appointment.patientId && reservation.offeringId === appointment.allocation?.offeringId
  && reservation.allocationFingerprint === appointmentAllocationFingerprint(appointment);

/** acceptedAppointments must be the server's accepted/current allocations, not all local proposals. */
export const appointmentAllocationIssues = (a: Appointment, data: FacilityRecords, acceptedAppointments: readonly Appointment[] = []): string[] => {
  if (!a.allocation) return [];
  const allocation = a.allocation;
  const offering = data.offerings.find((o) => o.id === allocation.offeringId && o.facilityId === a.facilityId && o.configuration === 'active');
  if (!offering || !a.scheduledFor) return ['Booking requires an active offering and start'];
  const interval = { startsAt: a.scheduledFor, endsAt: allocation.endsAt };
  const issues: string[] = [];
  let selectedSession: ServiceSession | undefined;
  if (offering.intakePolicy === 'walk_in') issues.push('This offering does not accept scheduled reservations');
  if (allocation.sessionId) {
    const sessions = currentFacilityRevisions(data.sessions).filter((s) => s.sessionId === allocation.sessionId && s.facilityId === a.facilityId);
    const session = sessions.length === 1 ? sessions[0] : undefined;
    if (!session || session.status !== 'published' || session.offeringId !== offering.id || !intervalContains(session, Date.parse(interval.startsAt))
      || Date.parse(interval.endsAt) > Date.parse(session.endsAt)) issues.push('Booking must fit one published service session');
    else {
      selectedSession = session;
      if (allocation.staffId && !session.participants.some((p) => p.staffId === allocation.staffId && p.assignmentId === allocation.assignmentId)) issues.push('Practitioner is not assigned to this session');
      const count = acceptedAppointments.filter((p) => p.facilityId === a.facilityId && p.id !== a.id && p.allocation?.sessionId === session.sessionId && !['cancelled', 'no_show'].includes(p.attendance ?? 'booked')).length;
      if (session.maxAppointments && count >= session.maxAppointments) issues.push('Session booking capacity is full');
    }
  }
  if (allocation.staffId) {
    const staff = data.staff.find((s) => (s.staffId === allocation.staffId || s.id === allocation.staffId) && s.facilityId === a.facilityId);
    const assignments = effectiveFacilityRevisions(data.assignments, Date.parse(interval.startsAt)).filter((s) => s.assignmentId === allocation.assignmentId && s.facilityId === a.facilityId);
    const assignment = assignments.length === 1 ? assignments[0] : undefined;
    if (!staff?.active || !assignment || assignment.staffId !== allocation.staffId || assignment.offeringId !== offering.id || assignment.status !== 'active'
      || !intervalContains(assignment, Date.parse(interval.startsAt)) || (assignment.endsAt && Date.parse(interval.endsAt) > Date.parse(assignment.endsAt))) issues.push('Named practitioner needs an effective service assignment for the full booking');
  }
  if (allocation.locations.some((r) => !offering.locationIds.includes(r.locationId))) issues.push('Booking location is not offered by this service');
  const peers = acceptedAppointments.filter((p) => p.id !== a.id && p.facilityId === a.facilityId && p.scheduledFor && p.allocation && !['cancelled', 'no_show'].includes(p.attendance ?? 'booked'));
  if (allocation.staffId && peers.some((p) => p.allocation!.staffId === allocation.staffId && intervalsOverlap(interval, { startsAt: p.scheduledFor!, endsAt: p.allocation!.endsAt }))) issues.push('Practitioner is already reserved');
  const claimFor = (p: Appointment) => ({ startsAt: p.scheduledFor!, endsAt: p.allocation!.endsAt, resources: p.allocation!.locations.map((r) => ({ ...r, mode: 'pooled' as const })) });
  const published = currentFacilityRevisions(data.sessions).filter((s) => s.facilityId === a.facilityId && s.status === 'published');
  const rootBookings = peers.filter((p) => !published.some((s) => s.sessionId === p.allocation!.sessionId));
  const claim = { ...interval, resources: allocation.locations.map((r) => ({ ...r, mode: 'pooled' as const })) };
  if (selectedSession) {
    const parent = selectedSession;
    if (allocation.locations.some((r) => !parent.resources.some((s) => s.locationId === r.locationId))) issues.push('Booking resources must be reserved by its parent session');
    const quotas = data.locations.map((location) => {
      const resource = parent.resources.find((r) => r.locationId === location.id);
      return resource ? { ...location, capacity: resource.mode === 'exclusive' ? location.capacity ?? 1 : resource.units } : location;
    });
    issues.push(...resourceCapacityIssues(claim, peers.filter((p) => p.allocation!.sessionId === parent.sessionId).map(claimFor), quotas, a.facilityId));
    issues.push(...resourceCapacityIssues(parent, [...published.filter((s) => s.sessionId !== parent.sessionId), ...rootBookings.map(claimFor)], data.locations, a.facilityId));
  } else {
    issues.push(...resourceCapacityIssues(claim, [...published, ...rootBookings.map(claimFor)], data.locations, a.facilityId));
  }
  return issues;
};

/** Optional login-window bridge; neither roster membership nor a signature establishes attendance/qualification. */
export const sessionRosterIssues = (session: ServiceSession, rosters: readonly RosterShift[]): string[] => session.rosterShiftIds.flatMap((id) => {
  const r = rosters.find((r) => r.id === id && r.facilityId === session.facilityId);
  return r && session.participants.some((p) => p.staffId === r.staffId) && Date.parse(r.startsAt) <= Date.parse(session.startsAt)
    && Date.parse(r.extendedUntil ?? r.endsAt) >= Date.parse(session.endsAt) ? [] : ['Linked sign-in window must cover its participant and complete session in this facility'];
});
export const workOwnershipHeadIssues = (v: WorkOwnershipEvent, heads: readonly WorkOwnershipEvent[]): string[] => {
  const same = heads.filter((h) => h.facilityId === v.facilityId && h.sourceType === v.sourceType && h.sourceId === v.sourceId);
  return (!v.previousId && !same.length) || same.length === 1 && same[0].id === v.previousId ? [] : ['Work ownership changed; preserve this conflicting claim/transfer for reconciliation'];
};
export const workOwnershipReferenceIssues = (v: WorkOwnershipEvent, source: Handoff, data: FacilityRecords, at: number): string[] => {
  const ending = v.action === 'release';
  const offering = data.offerings.find((o) => o.id === v.offeringId && o.facilityId === v.facilityId && (ending || o.configuration === 'active'));
  const destination = data.units.find((u) => u.facilityId === v.facilityId && (u.id === source.toUnitId || u.unitId === source.toUnitId));
  if (!offering || !destination || !ending && !unitIsRoutable(destination) || ![destination.id, destination.unitId].includes(offering.unitId)) return ['Ownership must route to an active offering in the instruction destination unit'];
  const issues: string[] = [];
  const receiving = v.action === 'offer_transfer' ? v.recipientStaffId : ['claim', 'accept_transfer'].includes(v.action) ? v.ownerStaffId : undefined;
  for (const id of receiving ? [receiving] : []) {
    const worker = data.staff.find((s) => s.facilityId === v.facilityId && s.staffId === id && s.active && s.permission === 'read_write');
    const assignments = effectiveFacilityRevisions(data.assignments, at).filter((a) => a.facilityId === v.facilityId && a.staffId === id && a.offeringId === v.offeringId && a.status === 'active' && intervalContains(a, at));
    if (!worker || !assignments.length) issues.push('Owner/recipient needs active membership and an effective assignment to this service');
  }
  return issues;
};

export type RetirementReference = { type: string; id: string; reason: string };
/** Impact preview only: never automatically cancel clinical work, bookings or historical records. */
export const facilityRetirementImpact = (target: { type: 'unit' | 'location' | 'service_offering' | 'staff'; id: string; facilityId: string }, data: FacilityRecords & {
  appointments?: readonly Appointment[]; ownershipHeads?: readonly WorkOwnershipEvent[]; handoffs?: readonly Handoff[];
}, now: number): RetirementReference[] => {
  const result: RetirementReference[] = [];
  const add = (r: { type: string; id: string; facilityId: string }, reason: string) => { if (r.facilityId === target.facilityId) result.push({ type: r.type, id: r.id, reason }); };
  const unit = data.units.find((u) => u.id === target.id && u.facilityId === target.facilityId);
  const worker = data.staff.find((s) => s.id === target.id && s.facilityId === target.facilityId);
  const ids = target.type === 'unit' && unit ? [unit.id, unit.unitId] : target.type === 'staff' && worker ? [worker.id, worker.staffId] : [target.id];
  if (target.type === 'unit') {
    data.units.filter((u) => u.active && u.parentId && ids.includes(u.parentId)).forEach((u) => add(u, 'Active child organization'));
    data.locations.filter((l) => l.active && l.unitId && ids.includes(l.unitId)).forEach((l) => add(l, 'Active linked location'));
    data.offerings.filter((o) => o.configuration === 'active' && ids.includes(o.unitId)).forEach((o) => add(o, 'Active service offering'));
  }
  if (target.type === 'location') {
    data.locations.filter((l) => l.active && l.parentId === target.id).forEach((l) => add(l, 'Active child location'));
    data.offerings.filter((o) => o.configuration === 'active' && o.locationIds.includes(target.id)).forEach((o) => add(o, 'Active service uses this location'));
  }
  for (const a of currentFacilityRevisions(data.assignments)) if (a.status === 'active' && (!a.endsAt || Date.parse(a.endsAt) > now)
    && (target.type === 'staff' && ids.includes(a.staffId) || target.type === 'service_offering' && a.offeringId === target.id || target.type === 'location' && a.locationIds.includes(target.id))) add(a, 'Effective/future assignment needs review');
  for (const s of currentFacilityRevisions(data.sessions)) if (s.status === 'published' && Date.parse(s.endsAt) > now
    && (target.type === 'staff' && s.participants.some((p) => ids.includes(p.staffId)) || target.type === 'service_offering' && s.offeringId === target.id || target.type === 'location' && s.resources.some((r) => r.locationId === target.id))) add(s, 'Published session needs replacement/cover');
  for (const a of data.appointments ?? []) if (a.allocation && a.scheduledFor && Date.parse(a.allocation.endsAt) > now && !['cancelled', 'no_show'].includes(a.attendance ?? 'booked')
    && (target.type === 'staff' && a.allocation.staffId && ids.includes(a.allocation.staffId) || target.type === 'service_offering' && a.allocation.offeringId === target.id || target.type === 'location' && a.allocation.locations.some((r) => r.locationId === target.id))) add(a, 'Booking requires explicit rescheduling');
  for (const ownership of data.ownershipHeads ?? []) if (ownership.action !== 'release'
    && (target.type === 'staff' && ownership.ownerStaffId && ids.includes(ownership.ownerStaffId) || target.type === 'service_offering' && ownership.offeringId === target.id)) add(ownership, 'Unfinished owned work requires acknowledged handover');
  const offering = target.type === 'service_offering' ? data.offerings.find((o) => o.id === target.id && o.facilityId === target.facilityId) : undefined;
  const offeringUnit = offering && data.units.find((u) => u.facilityId === target.facilityId && [u.id, u.unitId].includes(offering.unitId));
  const destinations = target.type === 'unit' ? ids : offeringUnit ? [offeringUnit.id, offeringUnit.unitId] : [];
  for (const h of data.handoffs ?? []) if (h.status !== 'done' && destinations.includes(h.toUnitId)) add(h, 'Unfinished service instruction needs an explicit destination review');
  return result;
};
