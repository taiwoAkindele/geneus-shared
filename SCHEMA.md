# Geneus Health — Data Contract (Schema Reference)

> The single source of truth for **document shapes** across the whole system.
> The Zod schemas in [`src/`](src/) are authoritative; this file is the
> human-readable explanation. Subordinate to [../PRODUCT.md](../PRODUCT.md).

Consumed by three layers (root [PLAN.md §9](../PLAN.md)):

- **`geneus-web`** — validates a document before writing it to local PouchDB.
- **`geneus-server`** — validates API payloads and reads documents in the change-feed consumer.
- **CouchDB** — enforces a structural subset at the DB level via a **generated**
  `validate_doc_update` (see §6).

## 1. Why one contract

In an offline-first system a document written on a phone today may not sync for up to
**7 days**. A silent frontend/backend schema mismatch therefore surfaces a week later,
far from its cause. One shared, validated contract is the protection against that class
of bug — which is why the schemas live here once and are never hand-duplicated.

## 2. The document envelope

Every persisted CouchDB document extends `baseEnvelope` ([`src/common.ts`](src/common.ts)):

| Field | Meaning |
| --- | --- |
| `_id` | CouchDB document id (see §4 for conventions). |
| `_rev` | CouchDB revision. Absent until the first save. |
| `type` | The discriminator — how documents are told apart in one JSON store (§3). |
| `facilityId` | Owning facility; how each per-facility DB stays isolated (guarded in §6). |
| `schemaVersion` | The shape version this doc was written against (§7). |
| `createdBy` / `createdOn` | Staff id + ISO time of creation (`'system'` for provisioning). |
| `deviceId` | Device the write originated on — used for conflict inspection. |
| `updatedBy` / `updatedOn` | Optional last-edit trail. |

CouchDB is **one bag of JSON per facility**, so `type` + `facilityId` do the work a
table name and a foreign key would do in SQL.

## 3. Document types (the `type` discriminator)

| `type` | Schema | PRD |
| --- | --- | --- |
| `patient` | `Patient` | §10 (NASADOR) |
| `visit` | `Visit` | §9.1 |
| `handoff` | `Handoff` | §9.7 |
| `register_entry` | `RegisterEntry` (union on `register`) | §9.4 |
| `referral` | `Referral` | §11 |
| `stock_item` / `stock_movement` | `StockItem` / `StockMovement` | §9.1, §9.6 |
| `facility` / `unit` | `Facility` / `Unit` | §9.7 |
| `staff` / `roster_shift` | `Staff` / `RosterShift` | §14.1 |
| `device_enrollment` | `DeviceEnrollment` | root §4.3c |
| `audit_event` | `AuditEvent` | §14 |

**Register entries are special:** all six carry `type: 'register_entry'` and discriminate
further on a `register` field (`opd` | `immunisation` | `family_planning` | `antenatal` |
`tb` | `malaria`). That two-level shape is why `AnyDocument` is a plain `z.union` rather
than a `type`-discriminated union — see the note in [`src/index.ts`](src/index.ts).

## 4. `_id` conventions

Stable, meaningful ids where one exists; otherwise a document-scoped id.

- **patient** → `_id` **is** the `patientId` (`OOE-PHC-000047-K2`). Stable and unique by
  construction (the safety code, PRD §10.1).
- **referral** → `_id` **is** the `referralId`.
- **facility / unit / staff** → their natural id (`code`, `unitId`, `staffId`).
- **visit / handoff / register_entry / stock_movement / audit_event** → an
  event-scoped id (a uuid or `<type>:<uuid>`), generated on the device.

> Patient IDs are **generated on the device, offline** (geneus-web). This contract only
> owns the **format** (`PATIENT_ID_RE`) — it validates, it does not mint.

## 5. Validate on every write

Both write paths must validate before persisting:

```ts
import { parseDocument } from '<submodule>/src';

const result = parseDocument(doc);
if (!result.success) {
  // reject the write / surface to the user — never silently store a bad doc
}
```

`parseDocument` uses the precise per-type schema when `type` is known, and falls back to
the full union otherwise. This is the guard against the 7-day-late failure in §1.

## 6. CouchDB `validate_doc_update` — GENERATED, not duplicated

CouchDB runs `validate_doc_update` **inside its own JS engine** and cannot import this
TypeScript. To keep the DB-level guard from drifting from the contract:

- **Rule:** the design-doc validator is **generated from these Zod schemas at
  build/deploy time** (`geneus-server`), not written by hand. Approach: Zod →
  JSON Schema (`zod-to-json-schema`) → a small compiled validator embedded in the design
  doc.
- **Scope:** the DB-level guard is a **thin structural second line of defence**, not a
  re-implementation of the whole contract. It should enforce at minimum:
  1. a known `type`,
  2. `facilityId` matches the database it is being written to (cross-facility guard),
  3. required envelope fields present,
  4. immutability of stable keys (`patientId`, `referralId` never change).
- **Rich validation stays in Zod** on the two write paths (§5). Belt (Zod) and braces
  (generated DB guard).

## 7. Versioning & migration

- `SCHEMA_VERSION` in [`src/common.ts`](src/common.ts) is bumped on any breaking change.
- Every document stores the `schemaVersion` it was written against, so old offline
  documents can be **up-migrated on read/sync** rather than requiring a flag-day.
- Additive, optional fields do **not** require a version bump; removing/renaming/retyping
  a field does.
- Because this is a git submodule, a schema change is a commit here + a submodule-pointer
  bump in each consuming repo (README §Consuming). Tag releases so both repos can pin a
  known-good contract.

## 8. Not in this contract

- **Auth secrets / credentials / roster signatures** — handled by `geneus-server`; only
  identity + role live in the replica (PRD §14).
- **Postgres analytics shapes** — those are derived projections owned by `geneus-server`,
  rebuilt from these documents (root §2.3), not part of the write contract.
- **API request/response envelopes** beyond the document shapes — add a `src/api.ts` here
  later if the two repos need to share those too.
