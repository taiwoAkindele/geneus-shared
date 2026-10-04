# Geneus Health — Data Contract (Schema Reference)

> The single source of truth for **what the client and the server must agree on**:
> record shapes, permissions, the offline policy and the API. The Zod schemas in
> [`src/`](src/) are authoritative; this file is the human-readable explanation.
> Subordinate to [../PRODUCT.md](../PRODUCT.md).

Consumed by two layers:

- **`geneus-web`** — validates a record and authorises the action before writing it to
  local SQLite; PowerSync then queues and uploads it.
- **`geneus-server`** — authenticates the device, authorises the attributed staff member,
  validates the record against the same schema, and applies it to PostgreSQL.

This repo is a **contract**, not an implementation layer. It holds nothing that only one
side needs (§10).

## 1. Why one contract

In an offline-first system a record written on a phone today may not sync for up to
**7 days**. A silent client/server schema mismatch therefore surfaces a week later, far
from its cause. One shared, validated contract is the protection against that class of
bug — which is why the schemas live here once and are never hand-duplicated.

The same argument applies to **authorization**: if the device and the server disagreed
about what a nurse may do, the disagreement would surface as a rejected upload a week after
the nurse pressed save. So the permission matrix (§8) lives here too — as vocabulary and
policy, enforced independently on each side.

## 2. The record envelope

Every synced record extends `baseEnvelope` ([`src/common.ts`](src/common.ts)):

| Field | Meaning |
| --- | --- |
| `id` | Primary key on both sides, minted by whoever creates the record (§4). Text, because PowerSync requires it. |
| `type` | The discriminator — which table/stream the record belongs to (§3). |
| `facilityId` | Owning facility; the isolation boundary (§6). |
| `schemaVersion` | The shape version this record was written against (§9). |
| `createdBy` / `createdOn` | Staff id + ISO time of creation (`'system'` for server-written records). |
| `deviceId` | Device the write originated on — used for conflict inspection. |
| `updatedBy` / `updatedOn` | Optional last-edit trail. |

`IMMUTABLE_ENVELOPE_FIELDS` (`id, facilityId, createdBy, createdOn, deviceId`) may never
change after creation. The server rejects a PATCH that touches one.

Field names are **camelCase** here and in the client's SQLite. PostgreSQL uses snake_case
(`facility_id`, `created_on`, …); the server maps at its boundary and the Sync Streams
alias columns back to camelCase on the way down. Nothing in this repo knows about the
snake_case names.

## 3. Record types (the `type` discriminator)

| `type` | Schema | Written by | PRD |
| --- | --- | --- | --- |
| `patient` | `Patient` | device | §10 (NASADOR) |
| `visit` | `Visit` | device — superseded by `encounter`, kept readable | §9.1 |
| `encounter` / `encounter_entry` | `Encounter` / `EncounterEntry` (values per step, §13) | device, insert-only | §9.8 |
| `handoff` | `Handoff` (optionally within an encounter) | device | §9.7 |
| `appointment` | `Appointment` | device | §9.8 |
| `register_definition` | `RegisterDefinition` | device | §9.4 |
| `register_entry` | `RegisterEntry` (values keyed by field id) | device | §9.4 |
| `referral` | `Referral` | device | §11 |
| `stock_item` / `stock_movement` | `StockItem` / `StockMovement` | device | §9.1, §9.6 |
| `facility` | `Facility` | **server** (registration) | §9.7 |
| `unit` | `Unit` | device | §9.7 |
| `staff` / `roster_shift` | `Staff` / `RosterShift` | device (`signature` server-only) | §14.1 |
| `device` | `Device` | **server** (enrollment / revocation) | root §4.3c |
| `audit_event` | `AuditEvent` | device and server, append-only | §14 |
| `sync_rejection` | `SyncRejection` | **server**; device may resolve | root §4.1 |
| `pin_setup_code` | `PinSetupCode` | **server**; device may mark it used | §14.1 |

"Server-written" types are synced *down* to the facility but an upload to them is rejected.

**Registers are data-driven (see §11).** A facility builds each register at runtime: a
`register_definition` record holds its typed `fields`, and each `register_entry` carries
a `values` map keyed by field id. There is **no per-register schema** — creating a register
is a record write, so it never needs a code change or a table migration.

## 4. `id` conventions

Stable, meaningful ids where one exists; otherwise a record-scoped id. Always minted on
the device, offline.

- **patient** → `id` **is** the `patientId` (`OOE-PHC-000047-K2`). Stable and unique by
  construction (the safety code, PRD §10.1).
- **referral** → `id` **is** the `referralId`.
- **facility / unit / staff / device** → their natural id (`code`, `unitId`, `staffId`,
  the device's own id).
- **register_definition** → `${registerId}:v${version}`.
- **visit / encounter / encounter_entry / handoff / register_entry / stock_movement /
  audit_event / sync_rejection** → an event-scoped id (`<type>:<uuid>`).

> Patient IDs are **generated on the device, offline** (geneus-web). This contract only
> owns the **format** (`PATIENT_ID_RE`) — it validates, it does not mint. The facility code
> is whatever registration accepted (`OOE-PHC`, or a single segment such as `OOE`). Two
> devices minting the same id is detected at upload and lands in the reconcile queue (§7);
> identity is never silently overwritten.

## 5. Validate on every write

Both write paths must validate before persisting:

```ts
import { parseDocument } from '<submodule>/src';

const result = parseDocument(record);
if (!result.success) {
  // reject the write / surface to the user — never silently store a bad record
}
```

`parseDocument` uses the precise per-type schema when `type` is known, and falls back to
the full union otherwise. On the device this runs before the SQLite write; on the server it
runs on every uploaded mutation before PostgreSQL. Belt and braces, same schema.

## 6. Facility isolation and the server guard

CouchDB used to enforce a per-database `validate_doc_update`. Its rules are now the
server's, applied to every uploaded mutation **after** authenticating the device:

1. `facilityId` must equal the authenticated device's facility — the value in the payload
   is checked, never trusted.
2. `deviceId` must equal the authenticated device.
3. `type` must be a known, uploadable type (§3).
4. Envelope fields present; `IMMUTABLE_ENVELOPE_FIELDS` unchanged on PATCH.
5. **Deletes are rejected.** Clinical history is retired by flag (`active: false`,
   superseded versions), never destroyed. There is no delete permission (§8).

Downloads are isolated by the facility-scoped Sync Streams: each stream is filtered on the
`facility_id` claim of the device's sync token, which the server minted from the device's
credential. The client never chooses its facility.

## 7. Conflicts and the reconcile queue

The server never picks a winner for clinical data. Per type:

| Type(s) | Rule |
| --- | --- |
| `register_entry`, `stock_movement`, `audit_event` | Append-only; PATCH rejected |
| `encounter`, `encounter_entry` | Insert-only; PATCH rejected. An `amendment` must amend an entry of the same encounter; once a closing step is saved, only amendments may be added (§13) |
| `register_definition` | Immutable per version; a colliding version is rejected, never overwritten |
| `patient` | Changed-column merge. If the server row and the device both changed the **same column** since the device's base, that column is a `conflict` |
| `appointment`, `handoff`, `referral`, `stock_item` | Changed-column merge; same-column race → `conflict` |
| `staff`, `roster_shift`, `unit` | Changed-column merge; a same-column administrative race applies the later upload and is audited |

Anything the server will not apply becomes a **`sync_rejection`** record with a
`category` (`identity`, `authorization`, `validation`, `conflict`), the reason, the
attributed staff member and — for conflicts — the columns with both values. A refused
`put` also carries the whole record as the device sent it (`refusedRecord`); a wholly
refused `patch` carries the fields it tried to set (`refusedChanges`). It syncs back down
to the facility so a records officer can resolve it (`sync_rejection:resolve`).

**No refused write is lost.** Whatever the category, a rejection stays in the queue until a
person either applies the write again or discards it. Either way `resolvedBy`,
`resolvedOn` and `resolution` record who decided and what — a discard is never silent and
never anonymous.

**A Patient ID taken by another device.** Two offline devices can mint the same Patient ID
(PRD §10.1). The second `put` is refused as a `conflict` carrying its `refusedRecord`, and
every later record from that device naming that patient (an encounter, an entry, a
handoff, an appointment) is refused into the queue with it, so none of it attaches to the
other patient. The records officer re-registers the patient under a new ID and re-saves
what was held; the original rejections stay as the trail.

## 8. Permissions and the offline policy

[`src/permissions.ts`](src/permissions.ts) defines:

- **`Permission`** — one explicit capability per action (`patient:create`,
  `encounter:record`, `register_entry:create`, `staff:manage`, …). No `*:delete` exists for
  any type. `encounter:record` covers every encounter step for every clinical role (CHEW,
  nurse, doctor, supervisor); per-step rules wait until the facility roles that need them
  (lab, pharmacy) exist.
- **`ROLE_PERMISSIONS`** and **`permissionsFor(role, staffPermission)`** — the matrix.
  `read_only` staff hold no permissions at all (every permission is a mutation).
- **`POLICY_VERSION`** — bumped when the matrix or the windows change.
- **`OFFLINE_AUTHORIZATION_POLICY`** — how long cached authorization stays valid:
  **7 days** in general (the existing sync-or-freeze window), **24 hours** for
  `HIGH_RISK_PERMISSIONS` (`staff:manage`, `staff:permission`, `staff:deactivate`,
  `device:enroll`, `device:revoke`).
- **`AuthorizationContext`** and **`decide(context, permission)`** — the pure decision
  both sides make: granted, and fresh enough?

How it is used:

- **Device.** The repository calls `decide` **before** any SQLite write. A denial means no
  local mutation and therefore nothing for PowerSync to upload. The UI may hide a button,
  but the repository is the rule.
- **Server.** On upload, the server rebuilds its own context from the *authenticated*
  device, its facility and its `staff` table — never from anything the client sent — and
  applies the same matrix. Server-side authorization is the final boundary; the client's
  exists so offline behaviour is deterministic.

What the server can and cannot verify is stated plainly: it verifies the **device**, its
**facility**, that the attributed staff member is an **active member** of that facility with
a **role** that grants the permission. It cannot verify which human typed the offline PIN —
attribution rests on the device's shift session (root §4.3a).

## 9. Versioning & migration

- `SCHEMA_VERSION` in [`src/common.ts`](src/common.ts) is bumped on any breaking change.
  **v3** replaced the CouchDB `_id`/`_rev` envelope with `id`, renamed `device_enrollment`
  to `device`, added `sync_rejection`, gave `audit_event` an outcome, and made
  `roster_shift.signature` optional until the server signs it.
- Every record stores the `schemaVersion` it was written against, so old offline records
  can be **up-migrated on read** rather than requiring a flag-day.
- Additive, optional fields do **not** require a version bump; removing/renaming/retyping
  a field does.
- A contract change is a commit here + a submodule-pointer bump in each consumer (README
  §Consuming). Tag releases so both repos can pin a known-good contract.

## 10. Not in this contract

- **Auth secrets / credentials.** A staff member's PIN is owned by **the device**: set and
  verified where it was set, never a record. A device's credential is held by the server
  as a **hash** and by the device as a secret; the `device` record carries neither.
- **Who may set a PIN.** A PIN is set on a device only with someone's approval, never by
  whoever is holding the phone. Two ways: a facility admin or supervisor on site enters
  their own PIN on that device, or an admin anywhere asks geneus-server for a one-time
  **PIN setup code** (`POST /staff/:staffId/pin-codes`) and reads it to the staff member.
  The `pin_setup_code` record syncs down with the code's PBKDF2 **hash** only (never the
  code), so the device checks it offline. It expires after 24 hours, a newer code for the
  same person revokes older ones, and the device marks it used by patching `usedOn` and
  `usedOnDevice` as that staff member (`pin_setup_code:claim`, a permission no role
  holds). The first admin sets their PIN with no approval, straight after registering
  the facility, because nobody else exists yet. On site, only a facility admin may
  approve a facility admin's PIN — whoever approves could choose the PIN themselves.
- **Admin recovery by email.** A facility admin's email is proven with a 6-digit code at
  registration (or added later by the admin) and kept on the server only — never a record,
  never synced to a phone. Replacing one already on file also needs a code sent to that
  current address, because the server knows the device, not who is holding it. A facility admin who forgets their PIN asks for a PIN setup code
  by email (`POST /staff/:staffId/pin-codes/email`, from any of the facility's enrolled
  devices); it is the same 24-hour, one-time code an admin would issue.
- **Roster signatures are the deliberate exception** — `roster_shift.signature` is a field
  precisely because devices must verify it offline. The server signs
  `rosterSignaturePayload` (staff, facility, start, end and any extension, as epoch
  milliseconds) with Ed25519 after the shift syncs up, and clears the signature whenever
  one of those fields changes, so the next signing pass covers the new values. A shift is
  unsigned until then and grants access either way (tamper-evidence, not an access gate);
  a signature that does **not** match refuses sign-in on that shift.
- **PostgreSQL schema, SQL, migrations** — `geneus-server`.
- **PowerSync configuration (Sync Streams), the connector, SQLite schema** — the
  consumers; they are derived from these shapes, never the other way round.
- **Fastify routes, React code, repositories, business logic** — the consumers.

## 11. Registers: data-driven and migration-free (PRD §9.4)

Registers are configured by each facility at runtime, not defined in code. This is what
lets a facility create a register with **no code change and no database migration**.

### 11.1 The shape

- **`register_definition`** — a form definition: `name`, `category`, `description`, `status`
  (`draft` | `published`), a `version`, and a `fields[]` array of `RegisterFieldDef`
  (`{ id, type, label, required?, help?, options? }`). Field `type` is one of
  `text · textarea · number · date · phone · select · multiselect · checkbox · section`.
- **`register_entry`** — an append-only row: `registerId`, `registerVersion`, `entryDate`,
  `setting` (Facility/Outreach, PRD §9.5), optional `patientId`, and a **`values` map keyed
  by `RegisterFieldDef.id`**.

In PostgreSQL, `fields` and `values` are the two places JSONB genuinely earns its keep: a
column-per-field table would need DDL every time a facility added a field.

### 11.2 Three rules that keep it migration-free

1. **Field ids are stable.** Entries reference fields by `id`, so an id is never reused or
   reassigned. Labels can change freely (they're display only); ids cannot.
2. **Edits version, they don't rewrite.** A `register_definition` is **immutable per
   `version`** (`id` = `${registerId}:v${version}`). Publishing an edit writes a *new*
   version; existing entries stay pinned to the `registerVersion` they were recorded against
   and still render against the fields they used. Historical data is never back-filled.
3. **Validation is definition-driven.** No static Zod schema can know a runtime register's
   fields, so `parseDocument` only checks the entry *envelope* and value *shapes*. Per-field
   rules (required, correct type, valid option) are enforced by
   **`validateRegisterEntry(fields, values)`** ([documents.ts](src/documents.ts)) on the
   write path, using the register's own definition.

## 12. The API ([`src/api.ts`](src/api.ts))

The handful of things that must happen online. Shapes only; handlers live in
`geneus-server`, the client in `geneus-web/src/lib/api`.

| Route | Request → Response | Purpose |
| --- | --- | --- |
| `GET /invites/:token` | → `InviteCheck` | Reject a bad invite before asking for details |
| `POST /facilities` | `FacilityRegistration` → `FacilityRegistrationResult` | Create the facility, its admin, and enrol the registering device |
| `POST /devices/codes` | `EnrollmentCodeRequest` → `EnrollmentCode` | An enrolled device issues a short-lived code (needs `device:enroll`) |
| `POST /devices` | `DeviceEnrollmentRequest` → `DeviceCredential` | The joining device spends the code |
| `POST /devices/:id/revoke` | `DeviceRevocationRequest` → `Device` | De-enrol; optionally request a wipe (needs `device:revoke`) |
| `POST /email-verifications` | `RegistrationEmailRequest` → `EmailSent` | Email a 6-digit code to the would-be admin (needs a valid invite) |
| `POST /staff/:staffId/email/code` · `POST /staff/:staffId/email` | `StaffEmailRequest` → `EmailSent` · `StaffEmailConfirmation` → 204 | A facility admin adds or changes their own recovery email (a code to the new address, and to the current one when replacing it) |
| `POST /staff/:staffId/pin-codes` | `PinSetupCodeRequest` → `PinSetupCodeIssued` | An admin issues a PIN setup code (needs `staff:manage`) |
| `POST /staff/:staffId/pin-codes/email` | *(device credential)* → `EmailSent` | A facility admin who forgot their PIN gets a PIN setup code by email |
| `POST /sync/token` | *(device credential)* → `SyncTokenResponse` | Short-lived PowerSync JWT: `sub` = device, `facility_id` claim |
| `POST /sync/upload` | `UploadRequest` → `UploadResponse` | The connector's write-back; every mutation authorised server-side (§6–§8) |
| `GET /time` | → `SignedTime` | The clock devices trust (unchanged from v2) |

`UploadResponse` acknowledges every mutation — `applied`, `duplicates` (already applied on
an earlier attempt; the idempotency ledger), or `rejected` with a category and reason. A
rejected mutation is not retried: it would only be rejected again, and would stall every
mutation queued behind it. Its record is the `sync_rejection` that syncs back down.

## 13. Encounters (PRD §9.8)

An encounter is one episode of care, recorded station by station. It is a header plus
append-only entries:

- **`encounter`** — `patientId`, `openedOn`, `setting`. Written when the first step is
  saved; never changed.
- **`encounter_entry`** — one saved, locked step: `encounterId`, `patientId` (repeated so a
  patient's history is one lookup), `step`, `actorRole`, an optional `amends`, and
  `values`. The envelope's `createdBy` / `createdOn` are the actor and the system time
  (PRD §9.8.5); `actorRole` is the role they held then.

Steps: `vitals · complaint · lab_order · lab_results · diagnosis · injection · dispense ·
admission · follow_up · amendment`. Each step's `values` has its own strict schema
(`ENCOUNTER_STEP_VALUES`), checked by `EncounterEntry` itself, so `parseDocument` covers
it with no extra call. Any step may be skipped (PRD §9.8.2); a step may be saved more than
once (a second set of vitals is a new entry).

Three rules make "saved means saved" (PRD §9.8.3) a property of the data, not the screen:

1. **Nothing is patched.** Entries and headers are insert-only; there is no
   `encounter:update`. Two devices recording the same patient therefore never race on a
   column.
2. **Corrections are amendments.** An `amendment` entry names the entry it corrects in
   `amends`; only an amendment may set it. Both stay visible.
3. **Closing is a step.** Saving `admission` (inpatient) or `follow_up` (sent home, with or
   without a review booked) closes the encounter (`CLOSING_STEPS`). An encounter is open
   while it has no closing entry; after one, only amendments are accepted.

A `handoff` may name the `encounterId` it moves the patient within, so the receiving unit
opens the same encounter.
