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
| `visit` | `Visit` | device | §9.1 |
| `handoff` | `Handoff` | device | §9.7 |
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
- **visit / handoff / register_entry / stock_movement / audit_event / sync_rejection** →
  an event-scoped id (`<type>:<uuid>`).

> Patient IDs are **generated on the device, offline** (geneus-web). This contract only
> owns the **format** (`PATIENT_ID_RE`) — it validates, it does not mint. Two devices
> minting the same id is detected at upload and lands in the reconcile queue (§7); identity
> is never silently overwritten.

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
| `register_definition` | Immutable per version; a colliding version is rejected, never overwritten |
| `patient` | Changed-column merge. If the server row and the device both changed the **same column** since the device's base, that column is a `conflict` |
| `appointment`, `handoff`, `referral`, `stock_item` | Changed-column merge; same-column race → `conflict` |
| `staff`, `roster_shift`, `unit` | Changed-column merge; a same-column administrative race applies the later upload and is audited |

Anything the server will not apply becomes a **`sync_rejection`** record with a
`category` (`identity`, `authorization`, `validation`, `conflict`), the reason, the
attributed staff member and — for conflicts — the columns with both values. It syncs back
down to the facility so a records officer can resolve it (`sync_rejection:resolve`). A
rejected clinical write is never discarded silently.

## 8. Permissions and the offline policy

[`src/permissions.ts`](src/permissions.ts) defines:

- **`Permission`** — one explicit capability per action (`patient:create`,
  `register_entry:create`, `staff:manage`, …). No `*:delete` exists for any type.
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
- **Roster signatures are the deliberate exception** — `roster_shift.signature` is a field
  precisely because devices must verify it offline. The server adds it after the shift
  syncs up; a shift is unsigned until then and grants access either way (tamper-evidence,
  not an access gate).
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
| `POST /sync/token` | *(device credential)* → `SyncTokenResponse` | Short-lived PowerSync JWT: `sub` = device, `facility_id` claim |
| `POST /sync/upload` | `UploadRequest` → `UploadResponse` | The connector's write-back; every mutation authorised server-side (§6–§8) |
| `GET /time` | → `SignedTime` | The clock devices trust (unchanged from v2) |

`UploadResponse` acknowledges every mutation — `applied`, `duplicates` (already applied on
an earlier attempt; the idempotency ledger), or `rejected` with a category and reason. A
rejected mutation is not retried: it would only be rejected again, and would stall every
mutation queued behind it. Its record is the `sync_rejection` that syncs back down.
