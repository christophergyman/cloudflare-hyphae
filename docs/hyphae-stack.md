# Cloudflare Hyphae - Tech Stack

- **Status:** Draft
- **Date:** 2026-10-04
- **Basis:** `docs/hyphae-adr.md` (ADR-017 to ADR-023), `docs/hyphae-plan.md`
- **Purpose:** The concrete choices behind the ADRs, so every agent builds against the same tools.

This document does not decide architecture (the ADR does). It pins the libraries, runtimes, and services used to implement the decisions.

---

## Principles

1. **Keep the seams.** `RepoStore` (ADR-007/018) and `packages/merge` (ADR-005) stay swappable. Nothing outside an adapter imports Artifacts, `isomorphic-git`, or a diff3 library directly.
2. **Shared code is runtime-agnostic.** `packages/core`, `packages/protocol`, and `packages/merge` use web-standard APIs only (fetch, WebCrypto, WebSocket), so they run in both workerd and Bun. No Node built-ins in shared packages. Lint enforces this.
3. **Verify, or keep both.** Nothing unverified is accepted.
4. **Lean into Cloudflare.** Use the managed primitive instead of building it, as long as it stays behind a seam.

---

## Stack by layer

| Layer | Choice | Why | Notes / risk |
|---|---|---|---|
| Language | TypeScript, strict, `moduleResolution: bundler`, ES2022 | One language, edge and client | No Node types in shared packages |
| Monorepo | Bun workspaces | Fast, works with Wrangler | `bun install`, workspace scripts |
| Client runtime | Bun | Fast startup for the daemon | The daemon uses `node:fs` where needed |
| Edge runtime | Workers (workerd) with a pinned `compatibility_date` | Cloudflare default | Bump the date deliberately, not blindly |
| Hub | **Agents SDK `Agent`** on a Durable Object, one per repo (ADR-017) | State, hibernating WebSockets, scheduling, RPC, observability for free | Drop to the raw DO API for the hot sync loop if the framework fights it |
| Hub storage | **SQLite-backed Durable Object** via the KV-style `ctx.storage` API (`get`/`put`/`delete`/`list`) (ADR-019) | Simple key/value access on a GA store, 10 GB per object | Per-path `manifest:` keys; `ctx.storage.sql` is a valid alternative when a queryable store is needed |
| Hub connections | **WebSocket Hibernation API** with `serializeAttachment` (ADR-019) | No duration charge while idle | Presence from `ctx.getWebSockets()` |
| Hub scheduling | **Durable Object alarms** driven by the Agent SDK scheduler (ADR-019) | Checkpoint cadence without blocking hibernation | Quiescence and ceiling logic lives here |
| MCP surface | **Agents SDK `McpAgent` / `createMcpHandler`** (ADR-013, ADR-017) | MCP with OAuth and hibernation, no hand-rolled transport | Planned (Phase 6), not built yet; targets the MCP 2026-07-28 spec |
| Blob store | **R2**, content-addressed `sha256` keys (ADR-004) | Cheap, egress-free | |
| Blob transport | **Worker-proxied R2** (`/blobs` PUT/GET) now; **R2 presigned PUT/GET URLs** deferred; small files inline under about 256 KB (ADR-020) | Protects the DO memory and CPU budget | Presign needs S3 credentials or the Workers presign path; the edge Worker proxies with a 1.5 MB cap today |
| Hashing | WebCrypto `sha256` | Works in both runtimes | No Node `crypto` |
| Durable history | **Artifacts**: binding for create/fork/inspect/tokens, **isomorphic-git** to commit and push (ADR-018) | The binding cannot write files, so git it is | **Verify the push in a Phase 0 spike** |
| Worker git | `isomorphic-git` plus an in-memory FS | The documented Artifacts pattern | Worker memory bounds tree size; push incremental packs |
| Durable jobs | **Workflows** | Durable multi-step merge job with retries | |
| Merge engine | Hand-rolled pure-JS diff3 in `packages/merge`, no dependency (ADR-005) | Small, swappable, runtime-agnostic | Swap in `node-diff3` only if the hand-rolled core ever hurts |
| Merging agent model | **AI Gateway**: frontier code model primary, Workers AI fallback (ADR-021) | Resilience, cost control, provider-agnostic | |
| Provider keys | **Secrets Store** via AI Gateway BYOK (ADR-021) | Centralized, referenced not pasted | |
| Merge verification | **Containers via `ctx.container`**, `durable_object` policy, **snapshots**; **Dynamic Workers** fast path for JS/TS (ADR-014) | Fast, safe, warm images | Legacy `Container`/`Sandbox` classes end Dec 31, 2026; snapshot support is public beta |
| Lazy checkout | **ArtifactFS** (optional) | Skip a full clone in the container | Experimental; needs Go and FUSE |
| Metrics | **Workers Analytics Engine** (ADR-022) | The one metric plus the moat signal, free | Thin metrics module in `packages/core` |
| Abuse resistance | **Rate limiting binding** plus AI Gateway limits (ADR-023) | Closes the top deferred risk cheaply | |
| Async fan-out | **Queues** (only if needed) | The Agents SDK already has a queue | Do not add unless the Hub needs it |
| Live view hosting | **Workers Static Assets** | No separate Pages project | |
| Later analytics and retrieval | **R2 SQL**, **Pipelines**, **R2 Data Catalog**, **Vectorize**, **AI Search** | The Phase 9 moat layer | Post-MVP |
| Later multi-tenant | **Workers for Platforms** | Dispatch namespaces | Post-MVP |

---

## Client stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript on Bun | |
| File watcher | Thin interface over **chokidar v4** (fallback: `@parcel/watcher` or raw `fs.watch`) | Swappable; verify reliability on Linux in Phase 0 |
| Debounce | Small custom debounce | No dependency needed |
| Hashing | WebCrypto `sha256` | Shared with the Hub |
| Atomic writes | Temp file plus `rename` | No half-written files |
| Local journal | Append-only file on disk (ADR-016) | Offline queue and replay |
| Identity | `@noble/ed25519` (or WebCrypto if verified), HMAC fallback (ADR-009) | Cross-runtime; verify in Phase 0 |
| WS client | Bun's global `WebSocket` | Reconnect with backoff |
| CLI | `cac` or `commander` plus `@clack/prompts` | Fast to build, good UX |
| MCP client | `@modelcontextprotocol/sdk` | Agents participate via our server too |

---

## Protocol and schema

| Concern | Choice | Notes |
|---|---|---|
| Message schemas | **Zod** (or Valibot) with a version field | Runtime validation on both ends |
| Wire format | JSON text frames for control; content by R2 reference (ADR-020) | Small files may inline |
| Versioning | Explicit protocol version in `hello` | Enables rolling upgrades |
| Config | `.hyphae/config.json`, validated by the same schema library | Holds the test command, ignore rules |

---

## Testing and tooling

| Concern | Choice | Notes |
|---|---|---|
| Pure packages | `bun test` | `core`, `protocol`, `merge` |
| Workers, DO, Workflow | **Vitest + `@cloudflare/vitest-pool-workers`** (or `@cloudflare/vitest-plugin`) | Runs inside workerd; `runInDurableObject`, `listDurableObjectIds`, isolated storage |
| Property tests | `fast-check` | The merge core especially |
| Integration | Miniflare via the Vitest integration | Two WebSocket clients, one Hub |
| Lint / format | Biome | One tool, fast |
| Deploy | Wrangler | `artifacts` binding, `remote = true` for local dev |
| Observability | Workers Logs, Tail Workers, and the Agents SDK tracing | Debug the Hub and the Workflow |

---

## Phase 0 spikes this stack depends on

1. **isomorphic-git push to Artifacts from a Worker** (ADR-018). The biggest unknown.
2. **Agents SDK `Agent` as the Hub**, with our two-client sync protocol (ADR-017).
3. **`ctx.container` plus snapshots**, then `npm ci && npm test` with an egress allowlist (ADR-014).
4. **R2 presigned PUT/GET** round trip from the client (ADR-020).
5. **AI Gateway** routing to a frontier model with a Workers AI fallback and a Secrets Store key (ADR-021).
6. **Ed25519** sign/verify in workerd, or confirm `@noble/ed25519` (ADR-009).
7. **Watcher reliability on Linux** (ADR-010).

---

## Status caveats (Oct 2026)

- **Agents SDK:** `^0.26.0`, tracks the MCP 2026-07-28 spec.
- **Artifacts:** open beta; binding cannot write files; billing active.
- **Containers `durable_object` policy and snapshots:** public beta. Legacy `Container`/`Sandbox` supported through Dec 31, 2026.
- **Dynamic Workers (Worker Loader):** open beta.
- **Vitest Workers integration:** `@cloudflare/vitest-pool-workers` 0.22.0; newer `@cloudflare/vitest-plugin` on Vitest 4.1+.
- **AI Gateway:** core features (caching, rate limiting, analytics) free on every plan.
- **ArtifactFS:** open source, experimental, needs Go and FUSE.

Everything beta sits behind a seam (`RepoStore`, the merge verifier interface), so a change is contained.
