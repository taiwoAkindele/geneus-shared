# Facility services, structure and staff assignments — shared contract

**Date:** 29 October 2026. **Implemented boundary:** canonical geneus-shared only. **Versions:** SCHEMA_VERSION 4, POLICY_VERSION 10, facility contract 1. The [approved plan](../docs/FACILITY-SERVICES-AND-STAFF-ASSIGNMENTS-PLAN-2026-10-29.md) and its backlog remain the feature-level reference.

This delivery supplies the record shapes, deterministic shared rules, compatibility vocabulary and tests needed by both consumers. It does not activate the application feature. No consumer checkout, submodule pointer, database, migration, route, PowerSync stream, key, production record or UI was changed in this stage.

## 1. Public models and ownership

Import through `src/index.ts`. `DocType`, `AnyDocument`, `SCHEMA_BY_TYPE` and `parseDocument` include all fifteen new types. The schema map is checked exhaustively against DocType at compile time.

| Record | Meaning | Write/change contract |
| --- | --- | --- |
| `location` | Actual site, building, room, ward, individual bed, store, service point, mobile or virtual context | Device configuration; revision CAS |
| `service_definition` | Reusable service concept and category, with explicit coding system | Device configuration; revision CAS |
| `service_offering` | Service delivered by one accountable unit, at chosen places, with intake policy/timezone | Device configuration; revision CAS |
| `practitioner_profile` | Existing staff identity's profession and specialties; no inferred licence | Device configuration; revision CAS |
| `credential` | Evidence/issuer, validity, verification author and restricted reference | Immutable versions; external verification recorded by authorized server operation |
| `capability_decision` | Independent approval, rejection, restriction, suspension or revocation of bounded action/service scope | Immutable versions; protected review authority |
| `reviewer_delegation` | Independent, scoped, effective approval/revocation of another reviewer | Immutable versions; cannot widen scope or extend the delegator's term |
| `clinical_authority_bootstrap` | Audited governance basis for a first reviewer, including explicit revocation | Server-only immutable versions; stable bootstrapId |
| `external_clinical_reviewer` | Actual external verifier identity and governance scope; no invented local Staff account | Server-only, restricted configuration |
| `authority_snapshot` | Minimal signed accepted clinical/reviewer authority | Server-only projection, monotonic accepted revision, expires within seven days |
| `staff_assignment` | Person's proposed/active/suspended/ended service duty, interval, places and cover | Immutable versions; assignment is not clinical approval |
| `service_session` | Finite coverage occurrence, participants, resource quantities, timezone, optional roster links | Immutable versions; publication is distinct from opening intake |
| `session_event` | Open/pause/resume/close intake for a service or occurrence | Append-only causal events |
| `work_ownership_event` | Claim, offer, accept, decline or release an existing Handoff instruction | Append-only causal events; current source adapter is `handoff` |
| `appointment_reservation` | Accepted/conflicting/released server allocation decision tied to exact booking content | Server-only projection |

`FACILITY_DOCUMENT_POLICY` is the common writer/change/privacy/permission map. It is metadata, not automatic enforcement or authorization to create a table. Restricted types are also enumerated by `RESTRICTED_FACILITY_DOCUMENT_TYPES` and tested against the map.

Existing documents gain optional fields:

- Unit: `kind`, `parentId`, `routingEnabled`, `revision`.
- Facility: authoritative `timeZone` and server-owned `workforcePolicy`.
- BillingDepartment: `organizationUnitId`, `revision`.
- Appointment: `allocation` for service/session, named worker/assignment, end and locations/quantities.
- EncounterEntry and ClinicalEvent: `actorContext` identifying offering, accepted authority snapshot and optional assignment revision/location.
- SyncRejection: `dependencies`, `visibility`, `visibleToStaffIds`; new dependency category.

Historical IDs and authors are retained. A physical location never becomes the old unit ID. A service definition is not a test/medicine catalogue. An individual bed does not prove occupancy. None of these models claims laboratory release, medicine fulfilment, attendance or payroll functionality.

## 2. Identity, history and effective time

References are facility-scoped. Legacy Unit.id and Unit.unitId may differ. `unitHierarchyIssues` resolves an unambiguous alias without rewriting identity, rejects cycles/name collisions and prevents active children under retired ancestors. `billingOrganizationIssues` validates the financial mapping without recalculating money. Normalized names aid sibling validation, never patient/staff identity matching or automatic migration.

Configuration changes increment revision exactly once and compare expectedRevision under a database lock. Legacy configuration without revision starts logically at one; its first protected update writes revision two. New configuration starts at one. `configurationRevisionIssues` and `facilityMutationIssues` specify this contract. Configuration must not use last-writer-wins for protected hierarchy/routing/mapping changes.

Versioned records retain stable business IDs and distinct revision IDs. A successor names its preceding revision and increments version, preserving facility, stream and worker identity. `facilityRevisionIssues` validates that relationship; `facilityHeadIssues` checks the sole accepted head. They complement database uniqueness/serialization, not replace it. Exact transport retries deduplicate before these checks.

`currentFacilityRevisions` retains forks instead of choosing the latest clock. `effectiveFacilityRevisions` follows causal predecessors when the accepted successor starts in the future. Do not treat a scheduled suspension/revocation as already effective today. A scheduled assignment ending remains active with a bounded endsAt until its end; status `ended` describes an ended assignment. Past revision history remains readable.

Instants carry offsets; intervals are half-open `[start,end)`. Calendar validity dates are real dates. Credential.validThrough includes the entire local calendar day in Credential.timeZone, including DST. Expiring evidence cannot support an unbounded capability interval. `credentialSupportsInterval` checks the complete approval interval. Updating/withdrawing evidence requires current accepted evidence references and new authority projection.

Session seriesId groups individually versioned finite occurrences; it is not an unlimited recurrence rule. Consumers generate and review bounded occurrences in the facility timezone, including overnight/DST cases, and allow one occurrence to be changed without rewriting past occurrences. Multiple same-day roster/session IDs remain distinct. Roster signatures retain their existing meaning and signed payload.

## 3. Authorization and privacy

Role/access, professional evidence, approved clinical capability, assignment, session, task ownership and login window are separate dimensions. New laboratory_staff/pharmacy_staff roles are access duties. Neither profession labels nor an administrator's generic encounter permission establish clinical authority.

The v10 permission matrix explicitly grants routine administration. `clinical_capability:review` and `pin_setup_code:claim` are excluded from AssignablePermission and all role grants. `withReviewerAuthority` strips a claimed review permission and adds it only when accepted, effective scoped reviewer proof matches the active writable worker. Scope/term containment and independent authorship are checked by `reviewerDecisionIssues`. Clinical approvals must also pass `facilityReferenceIssues`, including current verified evidence and approval interval.

`clinicalActivityIssues` requires all of:

1. Active writable facility membership matching the trusted context.
2. The specific clinical software permission, within the existing offline window.
3. A current accepted signature-verified snapshot for this worker/facility and exact policy version.
4. An effective grant for this action and offering.
5. Any required distinct qualified supervisor/checker.

`availableQualifiedActorIds` is trusted caller evidence of identity, presence and qualification for the actual action. A UI checkbox or selected staff ID is insufficient. The consumer must establish these conditions from its own authenticated/accepted context. Governance determines which activities require checking; reviewers record the relevant restrictions. No jurisdiction's profession/licence matrix is inferred by this contract.

`assignmentEligibilityIssues` checks full finite planned coverage using accepted authority and required service/assignment actions. It does not claim future physical attendance. Proposed/support assignments can exist without fabricated credentials; publication of clinical coverage requires eligibility for its intended interval. Actual clinical contribution always rechecks its own authority, regardless of a planning conflict.

`sessionClinicalCoverageIssues` validates each participant's intended actions and the service's collective coverage. Different qualified team members may cover assessment, prescribing and other duties; a receptionist/support participant is not forced to hold every clinical grant. Current offline proof is a bounded preflight: long-range or not-yet-effective approval must be forecast against complete accepted server records at publication, while an uncertain offline plan remains pending. Known future restrictions bound both projected scope intervals and proof expiry.

`encounterClinicalActions` covers current encounter steps. Diagnosis content with prescription lines or injection orders requires prescribing scope too. Lab results require record_result; administration and dispensing have their own activities. Other assessment contributions require assess. Amendments require the original entry in the same patient/encounter/facility and authority for both old and corrected content. A correction cannot bypass prescribing by using a generic note route; invalid/missing originals fail closed. `clinicalEventActions` covers longitudinal problems, medications and assessment records.

`mayApproveWorkforcePin` supplements existing PIN approval with the target's accepted authority: an administrator cannot reset an approved clinical/reviewer account into their own control without the corresponding accepted reviewer scope. Apply it to **every** PIN approval/reset/code issuance path after cutover. Target authority must be the authoritative current projection, or a verified accepted local copy; never arbitrary request JSON. `staffGovernanceIssues` prevents removal of the last active writable facility administrator. This does not prevent urgent revocation of unsafe clinical authority.

### Bootstrap and external verification

The audited deployment operation creates a bounded ClinicalAuthorityBootstrap from a real governance authorization; repeated operation identity must be idempotent. It is not a public onboarding toggle. Revocation is another version. Subsequent independent delegation uses protected review checks. A real external verifier has a restricted server-owned ExternalClinicalReviewer record; `externalReviewerIssues` checks authorized operation, independence, facility, effective period and scope. The operator must verify real-world identity and independence; different text IDs alone cannot prove two different humans. External decisions/evidence retain externalReviewerId and system provenance. No live professional-regulator connection is asserted.

### Signed minimal proof

`authoritySignaturePayload` defines domain-separated, deterministic signed JSON bytes: fixed keys, epoch instants, sorted scope/reference sets, stable code-point ordering, conditions and source IDs. Consumers use trusted server signing keys; signing/verification/key rotation belong in consumers. Parse the record first and verify these exact bytes. Bookkeeping fields do not confer authority.

`AuthorityProof.signatureVerified` is a trusted in-process result, **never a client-uploaded boolean**. Its currentRevision is the highest accepted revision known locally. The server re-derives authority from its accepted records and authenticated device, regardless of a supplied snapshot. A revoked/expired proof cannot be repaired by changing a role or roster signature.

`projectClinicalAuthority` is the shared deterministic projection rule over **accepted-only** source records. It removes revoked/suspended/expired/unsupported grants, excludes forks and withdrawn/superseded evidence, minimizes the output, and clips proof expiry at seven days, an applicable end, or the next known effective change. It does not sign or write anything. Source query completeness, acceptance, policy review, revision allocation and publication are consumer responsibilities.

Raw credential identifiers, evidence references, external identities and review details require restricted delivery. General staff/clinical replicas receive only operational directory and minimum accepted scope proof. Rejections of restricted records must have restricted visibility and a nonempty explicit audience as well; otherwise their preserved payload would leak through reconciliation. **Schemas do not implement row/column security:** protected queries, Sync Streams, routes, local caches, draft isolation and staff-switch cleanup are mandatory before exposing this feature.

## 4. Sessions, allocations and work ownership

`facilityReferenceIssues` checks same-facility organizations/locations/services/people, offering routing, complete assignment periods, temporary cover and session participants/resources. Clinical eligibility, cross-record head checks, permissions and capacity are additional mandatory checks. Draft configuration is distinct from active offerings. Unassessed resource readiness remains unassessed.

`sessionConflictIssues` detects incompatible exclusive staff commitments, resource capacity and accepted independent booking claims. Shared/on-call commitments remain explicit choices; planned coverage never proves a person is present. `resourceCapacityIssues` uses peak concurrent quantities, with end boundaries processed before starts. Three pooled claims can overrun capacity even when each pair fits. Disjoint claims inside a long occurrence are not simply summed. Exclusive use consumes the complete location capacity.

Appointment allocations are proposals. `appointmentAllocationIssues` validates published session bounds, named practitioner assignment, service places, booking capacity and actual calendar claims. Parent sessions reserve resource quotas; children consume that quota, without counting the parent a second time. Independent bookings cannot consume capacity already reserved exclusively by a session. `sessionBookingIssues` exposes affected reservations before reducing/changing/cancelling a session. Consumers serialize publication and reservation over the same resource/worker calendar keys. A local warning cannot guarantee exclusivity across disconnected devices.

`appointmentAllocationFingerprint` correlates reservation with appointment/facility/patient, normalized times, offering/session, worker/assignment and sorted resource quantities. It is not a cryptographic signature. `reservationMatchesAppointment` requires the current accepted decision and exact fingerprint; old acceptance cannot confirm an edited booking. Server allocation decisions remain distinct from financial charge/payment readiness. Consumers select the latest authoritative reservation revision before calling the helper.

`sessionEventIssues` and `sessionEventHeadIssues` validate intake transitions and the accepted current event. Scheduled coverage, actual intake and resource readiness remain independent. Linking a login roster uses `sessionRosterIssues`; a link neither grants qualification nor records attendance.

Ownership currently adapts existing Handoff instructions only. `workOwnershipReferenceIssues` checks the selected offering belongs to the destination unit and the proposed new owner/recipient has effective membership. `workOwnershipIssues` requires causal state, preserves the old owner through an offer, restricts acceptance to the named receiver, and keeps the prior owner after a decline. An outgoing assignment may end before handover; the receiver still needs current eligibility. `workOwnershipHeadIssues` serializes by facility/source type/source ID, **not offering alone**, so a second offering cannot independently claim the same source work.

Caller-provided canManage must come from trusted work_ownership:manage authorization. Clinical permission/qualification is checked independently when care is recorded. Handover never silently marks Handoff.done, clinical completion, logout or patient disposition. Unaccepted work stays with its service. Losing offline proposals remain recoverable.

`facilityRetirementImpact` reports active descendants, linked services, assignments, future sessions/bookings and unfinished work. It is a preview, not permission to rewrite them. Consumers must validate completeness, choose replacement destinations/cover, validate again under locks, and retain history. Urgent operational pause and unsafe authority revocation have their own explicit actions; no automatic cancellation is hidden in retirement.

## 5. Upload and reconciliation protocol

SyncTokenResponse optionally advertises facilityFeature only after implementation/readiness. New feature writes send facilityContractVersion=1, schemaVersion=4, policyVersion=10. UploadRequest validates metadata for known new types/protected optional fields/roles. `facilityCompatibilityIssues` also rejects unsupported/future/stale versions at the negotiated boundary, and can require compatible metadata for **all** writes when authority cutover is active.

Old API shapes remain valid for legacy operation. This is compatibility for a controlled rollout, not permission for old clients to bypass an active facility's policy. Missing feature support means preserve queued writes and require upgrade; do not turn an incompatibility into an acknowledged success or silently discard unknown columns. Server-side cutover/mixed-client checks are mandatory.

UploadMutation optionally carries expectedRevision and expectedPreviousId. Versioned writes explicitly use null on first creation or the exact previous revision ID. Both consumers parse/normalize the complete resulting record and retain its schema stamp; new facility writes stamp version 4. `facilityMutationIssues` rejects device authorship of server records/provenance, immutable patches/deletes, missing preconditions and nonsequential configuration revisions. This includes protected Unit hierarchy and BillingDepartment mapping changes. Consumers must separately inspect actual changed columns for immutable/server-owned fields, check permissions, and apply CAS/head constraints atomically.

For child-before-parent ordering:

1. Resolve dependencies inside a batch before validation/activation where possible.
2. If a reference is genuinely unaccepted, persist a dependency SyncRejection **with references and original submitted payload**, plus audit, before acknowledging that refusal.
3. Return its typed UploadRejection with dependencies and negotiated facilityContractVersion. Existing PowerSync transport may then advance, allowing later queued parent writes to upload.
4. Keep the child visibly pending/refused until an authorized reconciliation/resubmission succeeds. A refused parent leaves an explicit linked remedy. Preserve original provenance; do not impersonate the initial clinical author or silently activate a child.

Indefinitely retrying a queue-head child can prevent its later queued parent from ever uploading. This contract therefore uses the existing durable reconciliation path instead of inventing a second queue or falsely acknowledging acceptance. Transport/transaction failures still use the existing retry/idempotency behavior. Mutation identity/deduplication and current heads/resource reservations require real database constraints and transaction tests in the server stage.

## 6. Adoption sequence and remaining consumer work

The shared scope is ready for consumer implementation; the overall feature is not yet delivered. Implement in this order:

1. Pin this reviewed shared contract in both consumers. Build the actual migrations/columns, reference/index/uniqueness constraints and data mappers. Inventory legacy IDs and ambiguous mappings; do not invent rooms, credentials or verified approvals from labels/roles.
2. Add restricted evidence/governance and rejection delivery before replicating new records. Add minimum operational projections, appropriate authenticated reads and private draft/cache isolation.
3. Implement dependency reconciliation, exact retry deduplication, serialized configuration/current-head/calendar writes, ownership/intake transitions, and immutable/versioned repositories. Integrate all corresponding shared validators before persistence on both sides.
4. Implement audited bootstrap/external verification, signing/verification/key rotation, current authoritative projection, trusted server time and all clinical/amendment/PIN gates. Define jurisdiction-approved scopes, independent checks, evidence audience and delayed-care policy. Use assessDelayedClinicalTime only as a time-evidence classifier, not approval of backdated care.
5. Implement migration/readiness and client handshake, then configure real staff/service approvals. Facility.workforcePolicy starts in preparation or is absent. Explicit enforcement requires a governance reference, compatible versions, effective instant and completed readiness; it is never activated by importing this release.
6. Build the reviewed setup, staff, coverage, allocation and handover screens; retain combined sign-in/Home and uniform tabs. Complete the plan's real SQLite/PostgreSQL/PowerSync/browser/device checks before PHC/hospital pilot activation.

Shared checks cover relevant invariants in FSA-03/04/07–14/16–24/27–29. They do not mark server, web, migration, privacy delivery, real round-trip, concurrency or pilot tickets complete. No PRD completeness percentage is increased merely by this shared foundation.

## 7. Verification

The canonical Node test suite covers legacy contracts and the new models, privilege boundaries, independent review, actual Ed25519 canonical-byte verification, inclusive timezone/DST expiry, causal forks/future changes, pooled/parent capacity, booking fingerprints, handover, protected PIN maintenance, privacy metadata, compatibility and linked dependency recovery. Strict TypeScript checking includes every source and test with noUnusedLocals/noUnusedParameters.

Use consumer-provided Zod/TypeScript/Node dependencies; no dependency/package installation is required. See README for isolated contract checking. The checks here are shared-contract tests, not claims of database race safety, working replica isolation or end-to-end application behavior.
