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
| `register_definition` | `RegisterDefinition` | §9.4 |
| `register_entry` | `RegisterEntry` (values keyed by field id) | §9.4 |
| `referral` | `Referral` | §11 |
| `stock_item` / `stock_movement` | `StockItem` / `StockMovement` | §9.1, §9.6 |
| `facility` / `unit` | `Facility` / `Unit` | §9.7 |
| `staff` / `roster_shift` | `Staff` / `RosterShift` | §14.1 |
| `device_enrollment` | `DeviceEnrollment` | root §4.3c |
| `audit_event` | `AuditEvent` | §14 |

**Registers are data-driven (see §9).** A facility builds each register at runtime: a
`register_definition` document holds its typed `fields`, and each `register_entry` carries
a `values` map keyed by field id. There is **no per-register schema** — creating a register
is just a document write, so it never needs a code change or a DB migration. The six
statutory programme registers (OPD, Immunisation, FP, ANC, TB, Malaria) are simply seeded
definitions, not hard-coded types.

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

## 9. Registers: data-driven and migration-free (PRD §9.4)

Registers are configured by each facility at runtime, not defined in code. This section is
the reasoning behind that model — the thing that lets a facility create a register with **no
code change and no database migration**.

### 9.1 The shape

- **`register_definition`** — a form definition: `name`, `category`, `description`, `status`
  (`draft` | `published`), a `version`, and a `fields[]` array of `RegisterFieldDef`
  (`{ id, type, label, required?, help?, options? }`). Field `type` is one of
  `text · textarea · number · date · phone · select · multiselect · checkbox · section`.
- **`register_entry`** — an append-only row: `registerId`, `registerVersion`, `entryDate`,
  `setting` (Facility/Outreach, PRD §9.5), optional `patientId`, and a **`values` map keyed
  by `RegisterFieldDef.id`**.

Because CouchDB is one bag of JSON per facility (§2), creating a register or recording an
entry is just a `put`. No table, no column, no DDL — the same reason a new patient needs no
migration.

### 9.2 Three rules that keep it migration-free

1. **Field ids are stable.** Entries reference fields by `id`, so an id is never reused or
   reassigned. Labels can change freely (they're display only); ids cannot.
2. **Edits version, they don't rewrite.** A `register_definition` is treated as **immutable
   per `version`** (`_id` = `${registerId}:v${version}`). Publishing an edit writes a *new*
   version; existing entries stay pinned to the `registerVersion` they were recorded against
   and still render against the fields they used. Historical data is never back-filled.
3. **Validation is definition-driven.** No static Zod schema can know a runtime register's
   fields, so `parseDocument` only checks the entry *envelope* and value *shapes*. Per-field
   rules (required, correct type, valid option) are enforced by
   **`validateRegisterEntry(fields, values)`** ([documents.ts](src/documents.ts)) on the
   write path, using the register's own definition. Belt (`parseDocument`) and braces
   (`validateRegisterEntry`).

### 9.3 Reporting (a note for `geneus-server`)

The offline write path is migration-free; the **analytics projection is where a naïve design
would not be**. A column-per-field table would need Postgres DDL every time a facility adds a
register or a field. Store entry `values` as **JSONB** (or a key/value table) and query with
JSON operators, so new registers and fields need no schema migration downstream either.
Programme indicators (malaria positivity, ANC 4th-visit, immunisation dropout, …) are then a
mapping from well-known field ids/conventions to indicators, defined once — not a schema per
register.
