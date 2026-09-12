# geneus-shared

The **shared contract** for Geneus Health — everything the client
([`geneus-web`](../geneus-web)) and the server ([`geneus-server`](../geneus-server)) must
agree on, defined once:

- record shapes (Zod) and the schema version,
- permission names, the role matrix and the offline authorization policy,
- the request/response shapes of the server API.

It is a **contract, not an implementation layer**: no SQL, no PowerSync configuration, no
routes, no React, no repositories, no business logic. If only one side needs it, it does
not belong here.

This is a **plain git-submodule folder**: just TypeScript + Zod, **no `package.json`, no
build step**. The consuming repo supplies `zod` and its own tsconfig.

- **Schema reference (read this):** [SCHEMA.md](SCHEMA.md)
- **The contract:** [`src/`](src/)
  - `common.ts` — the record envelope, enums, ids, `SCHEMA_VERSION`
  - `documents.ts` — every record type
  - `permissions.ts` — `Permission`, `ROLE_PERMISSIONS`, the offline policy, `decide`
  - `api.ts` — the server API's request/response shapes
  - `index.ts` — public entry point, `AnyDocument`, `parseDocument`
- **Tests:** [`tests/`](tests/) — `node:test` suites pinning the matrix, the envelope and
  the API shapes. They run inside each consumer's test run (see below).

## Consuming it (git submodule)

Both consumers mount this repo at `shared/` and import from `shared/src`
(`#shared` in geneus-server, `@shared` in geneus-web).

```bash
git submodule add https://github.com/taiwoAkindele/geneus-shared.git shared
```

### Consumer requirements

- **`zod` installed** in the consumer (peer of this contract). Keep the version in sync
  across both repos.
- **TypeScript that allows `.ts` import specifiers** — relative imports here carry an
  explicit `.ts` extension so the same files load in a bundler and in Node. `geneus-web`
  uses `moduleResolution: "bundler"`; `geneus-server` uses `nodenext` with
  `allowImportingTsExtensions`, and Node runs the files directly via type stripping.
- Include `shared/src` in the consumer's `tsconfig` `include`, and `shared/tests` where
  the consumer's test runner should pick the contract tests up.

### Running the tests without a consumer

There is deliberately no `node_modules` here. To check the contract on its own, point a
scratch folder's `node_modules` at a consumer's (a symlink or junction), copy `src/` and
`tests/` beside it, and run `tsc --noEmit` and `node --test`. Inside a consumer they run
as part of `npm test`.

### Updating the contract

A contract change is: a commit **here** → then bump the submodule pointer in each consumer
(`git submodule update --remote shared` and commit). **Tag releases** so both repos can
pin the same known-good contract. See [SCHEMA.md §9](SCHEMA.md) for the versioning rules
(bump `SCHEMA_VERSION` on breaking changes; store it on every record).

## Rules of the road

- **Never hand-duplicate a schema, a permission name or an API shape** in a consumer —
  import it from here.
- **Validate on every write path** with `parseDocument` — a bad record written offline may
  not fail until it syncs (up to 7 days later).
- **Authorise on every write path** with `decide` — on the device before SQLite, on the
  server before PostgreSQL. The server's decision is the final one.
- **No secrets here** — PINs stay on the device, device credentials are hashed on the
  server; neither is ever a record.
- **No implementation here** — the moment a file needs a database driver, a framework or
  a UI library, it belongs in a consumer.
