# geneus-shared

The **shared data contract** for Geneus Health — the single source of truth for document
shapes used by both [`geneus-web`](../geneus-web) and [`geneus-server`](../geneus-server).

This is a **plain git-submodule folder**: just TypeScript + Zod, **no `package.json`, no
build step**. The consuming repo supplies `zod` and its own tsconfig.

- **Schema reference (read this):** [SCHEMA.md](SCHEMA.md)
- **The schemas:** [`src/`](src/) — `common.ts` (envelope, enums, ids), `documents.ts`
  (every document type), `index.ts` (public entry point, `AnyDocument`, `parseDocument`).

## Consuming it (git submodule)

> Requires each repo to be its own git repo, and this folder to be its own git repo.
> Nothing here is a git repo yet — initialize when you're ready.

1. Make this folder its own repo (once):
   ```bash
   cd geneus-shared
   git init && git add . && git commit -m "Initial data contract"
   # push to wherever you host it, e.g. a private git remote
   ```
2. Add it as a submodule inside each consumer (e.g. under `src/shared`):
   ```bash
   # in geneus-web and again in geneus-server
   git submodule add <geneus-shared-repo-url> src/shared
   ```
3. Import by path:
   ```ts
   import { Patient, parseDocument, PATIENT_ID_RE } from './shared/src';
   ```

### Consumer requirements

- **`zod` installed** in the consumer (peer of this contract). Keep the version in sync
  across both repos.
- **TypeScript that allows `.ts` import specifiers** — relative imports here carry an
  explicit `.ts` extension so the same files load in a bundler and in Node. `geneus-web`
  uses `moduleResolution: "bundler"`; `geneus-server` uses `nodenext` with
  `allowImportingTsExtensions`, and Node runs the files directly via type stripping.
- Include the submodule in the consumer's `tsconfig` `include`.

### Updating the contract

A schema change is: a commit **here** → then bump the submodule pointer in each consumer
(`git submodule update --remote src/shared` and commit). **Tag releases** so both repos
can pin the same known-good contract. See [SCHEMA.md §7](SCHEMA.md) for the versioning
rules (bump `SCHEMA_VERSION` on breaking changes; store it on every doc).

## Rules of the road

- **Never hand-duplicate a schema** in a consumer — import it from here.
- **Validate on every write path** with `parseDocument` — a bad doc written offline may
  not fail until it syncs (up to 7 days later).
- **CouchDB's `validate_doc_update` is generated from these schemas**, not written by hand
  (SCHEMA.md §6).
- **No secrets here** — auth credentials and roster signatures belong to `geneus-server`.
