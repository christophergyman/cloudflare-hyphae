# Cloudflare Hyphae - Architecture Decision Record (ADR)

- **Status:** Draft v0.1
- **Date:** 2026-10-04
- **Author:** Christopher Man (cman), with opencode
- **Companion doc:** `docs/hyphae-prd.md` (Product Requirements Document)
- **Scope:** Architecture for Phase 0 (MVP) with clear seams for Phases 1 to 3.

---

## Terminology at a glance

Read this first. These words are used throughout and are the whole vocabulary of the system.

| Term | Plain meaning |
|---|---|
| **op** (short for "operation"; proposed rename: **Edit**) | The smallest possible record of a single change: "in file X, at bytes 12 to 17, replace with this." An op is to Hyphae what a diff hunk is to git, except it is live and atomic. |
| **Edit / Edit stream** | A stream of ops, applied in order. |
| **Repo** | A shared coordinate space, backed by one Artifacts repository. |
| **Task** | A unit of intent ("add SSO"). The primary unit of coordination. |
| **Actor** | A human or an agent. Agents are first-class, sponsored by a human. |
| **Workspace** | The isolated-but-visible view a Task writes into. |
| **Signal** | Any append-only event (a claim, an op, a collision, a decision). The atomic stigmergic primitive. |
| **Claim** | A Signal declaring intent to touch a scope (paths/globs). |
| **Change** | A set of ops plus provenance, proposed for fusion. |
| **Overlay** | A Task's ordered op log on top of a base snapshot. |
| **Referee** | The Repo Durable Object. The single deterministic authority for order and truth. |
| **Council** | (Future) observer agents (reconciler, sentinel, reviewer, allocator) that propose actions. |
| **Materializer** | The client component that projects the op stream onto real files (or a virtual FS). |
| **Stigmergy** | Coordination via signals left in a shared space, with no central controller. |
| **Anastomosis** | The fusion of filaments in a mycelium; in Hyphae, the continuous fusion of work. |

Naming is not final. In particular, "op" is borrowed from CRDT/OT jargon and may be renamed to **Edit**, **Delta**, or **Patch** (tracked in Part 7, Open Questions).

---

## Part 0. How to read this document

This is both an architecture overview and a set of individual Architecture Decision Records (ADRs). Part 1 gives the system picture. Part 2 lists the decisions, each with context, decision, rationale, and consequences. Parts 3 to 7 cover data model, protocols, repo layout, Cloudflare mapping, and open questions.

Decision status values: **Accepted** (locked), **Proposed** (recommended, awaiting final confirmation), **Deferred** (future).

---

## Part 1. System Architecture Overview

### 1.1 Constraints that shape everything

1. Build on **Cloudflare's existing primitives**, and on **Artifacts** specifically for versioned storage.
2. The participants are **teams of engineers**, each running one or more AI agents on shared code.
3. The core problem is **deferred merge conflict**. The fix is **continuous fusion** (mycelium anastomosis) with **no lost work**.
4. **Bind, do not run** agents. Hyphae is agent-agnostic.
5. Models get smarter over time, so put judgment in a replaceable intelligent layer and keep a deterministic, provable floor.
6. **Blazingly fast** means two budgets: local interaction (instant) and network propagation (tens of ms, masked by local-first).
7. **Artifacts is open beta** (usable now on Workers Paid, API still moving).

### 1.2 Component diagram

```
        humans + agents (any harness)   via   CLI / MCP server / HTTP API
                                    │
                        ┌───────────▼────────────┐
                        │   EDGE WORKER          │  stateless
                        │   auth · routing · API │  protocol · WebSocket upgrade
                        └───────────┬────────────┘
        ┌───────────────┬───────────┴───────────┬──────────────────┐
        │               │                       │                  │
   ┌────▼─────────┐ ┌───▼──────┐        ┌───────▼──────┐    ┌──────▼──────┐
   │  REPO DO     │ │  D1      │        │  Vectorize   │    │  R2         │
   │  REFEREE     │ │  global  │        │  semantic    │    │  blobs      │
   │  op log      │ │  ledger  │        │  awareness   │    │  snapshots  │
   │  overlays    │ │  tasks   │        └──────────────┘    └─────────────┘
   │  claims      │ │  provenance
   │  signals     │ │
   │  WebSockets  │ └──────────┘
   └───┬──────────┘
       │  alarms: checkpoint · claim TTL · compaction
       ▼
   ┌─────────────────────────────────┐
   │  RepoStore port (interface)     │
   │   ├── Artifacts adapter (first) │  git history · time-travel · forks · interop
   │   └── fallback adapter (later)  │
   └─────────────────────────────────┘
       ▲
   Queues / Event Subscriptions ──► fan-out · CI · notifications
   Workers AI / AI Gateway ──────► Council (future): reconcile · review · allocate
```

### 1.3 The three-tree mapping (git, inverted)

```
  Git today                       Hyphae
  Object store   (history)   ->   Artifacts  (durable git history)
  Index          (staging)   ->   Repo DO    (LIVE, shared index)
  Working tree   (files)     ->   client Materializer (local FS daemon today)
```

Git's index is per-developer and private. Ours is shared and live. That inversion is the product.

### 1.4 Write path (an edit)

```
 agent edits file
   │
   ├─(1) apply locally, immediately        <-- interaction budget, <5ms, never blocks
   │
   ├─(2) emit Op to daemon
   │
   ├─(3) daemon streams Op over WebSocket  <-- propagation budget, tens of ms
   │
   ├─(4) Repo DO validates, assigns seq, appends to task overlay
   │
   ├─(5) DO updates in-memory region index, detects overlap
   │        └─ if overlap: emit Collision Signal to affected clients
   │
   ├─(6) DO broadcasts Op + Signals to subscribers (interest-filtered)
   │
   └─(7) DO persists Op to its SQLite storage      <-- durable immediately, never discarded
```

### 1.5 Read path (a file read)

```
 agent reads file
   └─ daemon serves from local materialized directory (base snapshot + applied ops)
      missing content hydrated lazily from Artifacts/R2 (ArtifactFS-style)
```

Reads never touch the network in the hot path.

### 1.6 Checkpoint path

```
 Repo DO (alarm: every N ops / on quiescence / on demand)
   └─ compact overlays -> tree -> RepoStore.writeCommit(...)
        └─ Artifacts adapter commits to git history
           (dense history, time-travel, forks, interop)
```

Non-blocking. Checkpoints never gate the interaction path.

---

## Part 2. Decisions

### ADR-001: Layer above storage; do not rebuild git

- **Status:** Accepted
- **Context:** Cloudflare Artifacts already provides agent-scale, git-compatible versioned storage (Durable Objects + R2 + KV, Zig/WASM git server).
- **Decision:** Hyphae owns the coordination, collaboration, and surface layers. It does not reimplement git storage or the git wire protocol.
- **Rationale:** The storage and protocol layers are commodities. The unsolved, high-value problem is coordination among concurrent writers.
- **Consequences:** Hyphae depends on an external storage backend (mitigated by ADR-002). Git interop is inherited, not built.

### ADR-002: RepoStore port with Artifacts as the first adapter

- **Status:** Accepted
- **Context:** Artifacts is in open beta: usable now, API still changing, with a live large-push bug and undocumented fork cost accounting.
- **Decision:** Define our own `RepoStore` interface. The core depends only on the interface. Artifacts is the first adapter; a fallback adapter (for example `zllovesuki/git-on-cloudflare`, or plain GitHub/GitLab remotes) can be added without touching the core.
- **Rationale:** Cheap insurance; keeps the primitive vendor-neutral; matches "primitive for the future."
- **Consequences:** A small amount of adapter code. We must keep `RepoStore` minimal (see Part 3).

Proposed `RepoStore` surface:

```
createRepo(name) -> Repo
getRepo(name) -> Repo
importRepo(sourceUrl, target) -> Repo
forkRepo(name, opts) -> Repo
readRef(name, ref) -> CommitHash
readObject(name, hash) -> bytes
readTree(name, hash) -> Tree
writeCommit(name, parentHash, tree, message, meta) -> CommitHash
updateRef(name, ref, hash) -> void
```

### ADR-003: One Repo Durable Object per repo is the deterministic Referee

- **Status:** Accepted
- **Context:** We need one canonical order for convergence without CRDTs, plus real-time fan-out.
- **Decision:** A single Durable Object per repo holds the live state (op log, overlays, claims, signals) and all WebSockets. It is the single serialization point.
- **Rationale:** A single-threaded authority gives total order, strong consistency, and free convergence. Splitting state across many DOs reintroduces the multi-writer reconciliation problem.
- **Consequences:** A per-repo throughput/memory ceiling. Store ops in SQLite (not memory); compact at checkpoints. Task DOs are a designed-for future option (see ADR-003b).

### ADR-003b: Task DOs are a future scale-out, not day-one

- **Status:** Deferred
- **Decision:** Keep the data model able to partition per task later (a Repo DO hub plus Task DOs), but do not build it now.
- **Rationale:** Preserves the single-referee elegance while keeping a scale path.

### ADR-004: Event-sourced model; Task is a mesh node

- **Status:** Accepted
- **Context:** The primary unit of coordination is a Task; work branches and fuses (mycelium).
- **Decision:** Model everything as an append-only Signal log. Task is a first-class entity that can branch (sub-tasks) and fuse (merge with other tasks). Fusion is a first-class operation.
- **Rationale:** Event sourcing gives provenance, replay, and never-discard for free. A mesh matches how agents decompose and converge work.
- **Consequences:** Requires a derived-view layer for current state (overlays, claims, task status). Fusion operations must be modeled now even if not exposed in Phase 0.

### ADR-005: Bespoke region-op format; no CRDT

- **Status:** Accepted
- **Context:** We need deterministic fusion and collision detection; the Referee already serializes writes.
- **Decision:** Define a small region-op format (file path plus byte range plus kind), applied in Referee-assigned sequence order to a base revision. Detect overlap with an interval index. Do not adopt a CRDT.
- **Rationale:** The single Referee provides convergence, so CRDT machinery is unnecessary. A code-aware op format is our differentiator.
- **Consequences:** We own op-format correctness. CRDTs remain an escape hatch only if the repo is ever sharded across DOs (ADR-003b).

Proposed op schema:

```
Op = {
  id:       ULID            // sortable, unique
  seq:      number          // assigned by the Referee
  taskId:   string
  actorId:  string
  base:     CommitHash      // snapshot the op applies to
  path:     string
  range:    { start, end }  // byte offsets in base file
  kind:     insert | delete | replace
  payload:  bytes | Ref     // large content by reference (R2/Artifacts)
  intent?:  string          // human/agent-readable why
  sig:      signature       // actor signature
  ts:       number
}
```

Collision rule: two ops collide when they share `path` and their effective ranges intersect after applying all earlier ops in sequence order. Non-colliding ops fuse automatically; colliding ops emit a Collision Signal.

### ADR-006: Local-first optimistic client; snapshot plus ordered op stream

- **Status:** Accepted
- **Context:** Interaction must feel instant; propagation crosses the network to a single DO.
- **Decision:** The client applies edits locally first and streams ops in the background. On connect it fetches a base snapshot and then a strictly ordered op stream (with sequence numbers) over a persistent WebSocket, with interest-based subscriptions and reconnect catch-up.
- **Rationale:** Never make the agent wait on the network. Total order plus deterministic ops guarantees convergence.
- **Consequences:** Needs optimistic local application, reconciliation on Referee confirmation, and a catch-up protocol (seq-based replay or re-snapshot).

### ADR-007: Materializer is a client-side, replaceable projection

- **Status:** Accepted
- **Context:** Current models are trained to use read/write tools on real local files, but the core should not depend on that.
- **Decision:** Keep the core op-based and filesystem-agnostic. The local FS daemon is one Materializer implementation behind a stable interface. Future Materializers: lazy-mounted virtual FS, or direct-op agents that emit structured edits.
- **Rationale:** "Take the L now, but quarantine it." Dropping local files later must be a client swap, not a core rewrite.
- **Consequences:** The daemon does atomic apply, lazy hydration, reconnect, and partial reads. It is the primary Phase 0 engineering risk, but bounded because the op stream is exact.

### ADR-008: DO persists live truth; Artifacts holds durable history

- **Status:** Accepted
- **Context:** Never-discard conflicts with treating Artifacts as always-current truth.
- **Decision:** The Referee persists every op on arrival (durable DO storage). Artifacts receives automatic, frequent checkpoints (every N ops, on quiescence, on demand). The DO never discards an op; Artifacts never needs to be current to be correct.
- **Rationale:** In-flight work can never be lost, even mid-edit or on process death. History stays clean and git-shaped.
- **Consequences:** Two durable stores with distinct jobs. Checkpoint cadence is automatic and invisible.

### ADR-009: Layered collision semantics

- **Status:** Accepted
- **Context:** Geometric overlap is exact but misses semantic conflicts; semantic detection is powerful but non-deterministic.
- **Decision:** Deterministic line/region ops are the floor and the source of truth. A semantic advisory tier (embeddings/AST, plus a decision model such as Cloudflare Clef behind a provider-agnostic interface) provides advisories only.
- **Rationale:** Keeps a crisp line: determinism for what is true, intelligence for what is smart.
- **Consequences:** The semantic tier is deferred beyond Phase 0, but the interface seam is defined now.

### ADR-010: Trust model is membership-based; no gates

- **Status:** Accepted
- **Decision:** Being in the network grants full trust; removal revokes it. No ACLs, roles, or approval gates. Safety comes from visibility and reversibility. Blast-radius circuit breakers (operational, not approval) and sentinel agents are post-MVP.
- **Rationale:** Simplicity, and consistency with a trusted team. Security becomes detect, contain, reverse.
- **Consequences:** A runaway agent can touch everything; mitigated by the floor (nothing lost, everything revertible) plus future sentinels and breakers.

### ADR-011: Agents are first-class actors sponsored by humans

- **Status:** Accepted
- **Decision:** An Actor is a human or an agent. Every agent has its own identity and signature, linked to a sponsoring human who is accountable. Both attribution and rate/behavior controls key off actor identity.
- **Rationale:** Stigmergy requires addressable agents; never-discard requires precise provenance; capability-adaptive trust requires per-participant history.
- **Consequences:** Identity and signing are Phase 0 requirements.

### ADR-012: Participant protocol is MCP plus CLI plus HTTP; bind, do not run

- **Status:** Accepted
- **Decision:** Any harness participates via an MCP server (agent-facing), a CLI (human-facing), and an underlying HTTP/WebSocket API. Hyphae never executes agents.
- **Rationale:** Maximizes participation, keeps the build small, and lets "models get smarter" plug in for free.
- **Consequences:** The MCP tool surface is a stable contract. Hosted execution (Cloudflare Agents SDK, Containers, Sandboxes) is an optional future surface.

Proposed MCP tool surface (Phase 0):

```
join_task(taskId)            attach this agent to a task
leave_task(taskId)
claim_scope(paths | globs)   declare intent to touch scope
release_scope(paths)
read_file(path)              (or rely on local FS)
apply_edit(path, range, ...) emit an op
list_signals(since)          see in-flight signals and collisions
list_collisions()            unresolved overlaps
note_intent(text)            stigmergic annotation
request_checkpoint()         force a git checkpoint
revert(changeId)             reversible undo
status()                     task/actor/workspace state
```

### ADR-013: Stack is TypeScript everywhere, Bun on the client, WASM-ready seams

- **Status:** Accepted
- **Decision:** TypeScript for Workers, Durable Objects, CLI, MCP server, daemon, and board. Bun as the client/CLI runtime for fast startup. Keep the op engine a pure, runtime-agnostic module (web-standard APIs only) so it runs identically in workerd and Bun, and can later be compiled from Rust to WASM.
- **Rationale:** One language, one toolchain, fastest path to a walking skeleton. Speed comes primarily from local-first architecture (ADR-006), not the language. WASM remains the escape hatch for CPU-bound hot spots.
- **Consequences:** Avoid Node-only APIs in shared code. Profile before moving anything to WASM. The WASM swap must not touch the rest of the system.

### ADR-014: Surfaces are CLI plus MCP; the board is thin

- **Status:** Accepted
- **Decision:** CLI and MCP server are the product. The live web board is a thin view over the WebSocket feed.
- **Rationale:** Engineering value is in the participant protocol and coordination core; the board is cheap to generate and serves as the "watch the swarm" spectacle.
- **Consequences:** Board is a consumer of the same public feed; it must not require special core support.

### ADR-015: The Council is a future observer-agent layer

- **Status:** Deferred
- **Decision:** Future capabilities (reconciling, security, review, allocation) are added as observer agents that read signals and act by emitting signals and requests, never by mutating truth directly. The Referee remains the only writer of truth.
- **Rationale:** Keeps the substrate stable while capability grows; new intelligence is additive.
- **Consequences:** Design signal and request schemas so observer agents can be added without core changes.

---

## Part 3. Data Model

### 3.1 Entities

```
Repo
  id, name, storeRef, createdAt, defaultBranch

Task
  id, repoId, title, intent, status(Open|Active|Settled|Closed)
  flags{colliding, contested, quarantined}
  parentTaskId?            // mesh: branch
  fusedWith[]              // mesh: fusion
  actors[]                 // humans + agents
  createdAt, updatedAt

Actor
  id, kind(human|agent), displayName, sponsorActorId? (agents), publicKey

Workspace
  id, taskId, baseHash, overlayOps[], materializerKind

Signal
  id, seq, repoId, taskId, actorId, kind, payload, ts, sig
  kinds: claim | release | op | collision | resolution | intent | checkpoint | containment

Claim
  id, taskId, actorId, scope(paths|globs), rangeHint?, expiresAt

Change
  id, taskId, opIds[], provenance, status(proposed|fused|reverted)

Checkpoint
  id, repoId, commitHash, uptoSeq, ts
```

### 3.2 Derived views (projections over the Signal log)

- current overlays per task
- active claims and scope map
- open collisions
- task status and mesh edges
- fused shared view as of a given seq

### 3.3 Mesh relations

- Task `parentTaskId` gives branching.
- Task `fusedWith` gives fusion (anastomosis).
- Task fusion is modeled in Phase 0 data, exposed later.

---

## Part 4. Protocols

### 4.1 WebSocket op stream

```
client -> server:
  hello { actorId, taskId, resumeFromSeq? }
  subscribe { paths|globs }
  unsubscribe { paths|globs }
  op { Op }
  ack { seq }

server -> client:
  snapshot { baseHash, uptoSeq }
  ops { [Op], seq range }
  signals { [Signal] }
  collision { taskIds, path, ranges, ctx }
  checkpoint { commitHash, uptoSeq }
  catchup { fromSeq, ops | resnapshot }
```

### 4.2 Interest subscriptions

- Clients subscribe to paths/globs. The Referee fans out only relevant ops and signals.
- Claims are compiled into the subscription index to prioritize delivery to interested parties.

### 4.3 HTTP / REST (supporting)

- `POST /repos`, `GET /repos/:name`
- `POST /repos/:name/tasks`, `GET /tasks/:id`
- `GET /repos/:name/signals?since=`
- `POST /repos/:name/checkpoint`
- `POST /changes/:id/revert`

### 4.4 Checkpointing

- Trigger: every N ops, on quiescence, or on demand.
- Action: compact overlays into a tree, `RepoStore.writeCommit`, `updateRef`.
- Recovery: if the DO is lost, rebuild live state from the last checkpoint plus replayable op log (ops are persisted; a rebuild path must be defined).

---

## Part 5. Repository and Tooling Layout

Monorepo, Bun workspaces (or Turborepo) for build orchestration.

```
/apps
  /cli            Bun + TS   human CLI and the long-lived local daemon (Materializer)
  /mcp            TS         MCP server for agent participation
  /board          TS         thin live web board (WebSocket consumer)
/workers
  /edge           TS         Workers: auth, routing, REST, WebSocket upgrade
  /repo-do        TS         Durable Object: the Referee
/packages
  /core           TS         domain: Repo, Task, Actor, Signal, Claim, Change, mesh
  /engine         TS         op apply, diff, interval index, fusion (WASM-ready, pure)
  /protocol       TS         op format, WS schema, REST types (shared, versioned)
  /repostore      TS         RepoStore port + Artifacts adapter (+ fallback later)
  /client         TS         shared client sync/replica logic
  /materializer   TS         Materializer interface + local FS implementation
/infra
  wrangler.toml, D1 migrations, queues config
/docs
  hyphae-prd.md, hyphae-adr.md
```

Language and runtime notes:

- All TS. Client runs on Bun for startup speed. Workers/DO run on workerd.
- Shared packages must use web-standard APIs only (fetch, crypto, streams, WebSocket) to run in both runtimes.
- `/engine` is the designated WASM swap point.

---

## Part 6. Cloudflare Primitive Mapping (finalized)

| Need | Primitive | Notes |
|---|---|---|
| Durable versioned storage, git interop | **Artifacts** | First `RepoStore` adapter; open beta; Workers Paid |
| Live coordination core | **Durable Objects** | One per repo; SQLite storage; WebSockets + hibernation |
| Stateless edge API, auth, routing | **Workers** | Protocol endpoints, WS upgrade |
| Global queryable metadata | **D1** | Tasks, provenance, audit, cross-repo search later |
| Large blobs, snapshots | **R2** | Referenced by ops; never streamed through the DO |
| Semantic awareness | **Vectorize** | Advisory collisions (post-MVP) |
| Fan-out, async jobs, CI hooks | **Queues / Event Subscriptions** | Idempotent handlers (at-least-once) |
| Intelligent ceiling | **Workers AI / AI Gateway** | Clef/Jev behind a provider-agnostic interface (post-MVP) |
| Optional hosted execution | **Agents SDK / Containers / Sandboxes** | Not load-bearing; bind, do not run |

---

## Part 7. Open Questions and Future ADRs

1. **Rebuild/replay path:** exact procedure to rebuild a lost Repo DO from checkpoint plus op log.
2. **Fork cost accounting:** confirm Artifacts fork storage billing before any fork-per-task usage.
3. **Large-push bug:** Artifacts currently fails `git push` near 64 MiB; determine impact on checkpoint strategy for big repos.
4. **Rate limits:** design around 2,000 git requests per 10s per repo and 2,000 control-plane requests per 10s per namespace.
5. **DO location:** choose a location hint strategy per repo (colocated team vs distributed).
6. **Semantic tier:** finalize the provider-agnostic `judge(state, typedQuestions)` interface and pick the first backend (Clef-flash recommended).
7. **Blast-radius circuit breakers:** define thresholds and behavior (Phase 1).
8. **Identity and signing:** choose key management for human and agent identities.
9. **Offline mode:** define behavior when a client disconnects for a long time (op queueing vs re-snapshot).
10. **Naming:** confirm primitives (Task, Signal, Claim, Referee, Council, Materializer) before code.

---

## Appendix A. Decision Log (interview to ADR mapping)

| Interview | ADR |
|---|---|
| Q1 layer above storage | ADR-001 |
| Q19 RepoStore abstraction | ADR-002 |
| Q17 one Repo DO | ADR-003, ADR-003b |
| Q5, Q14 task mesh, event-sourced | ADR-004 |
| Q8, Q9 region ops, no CRDT | ADR-005 |
| Q6, Q7 local-first continuous | ADR-006 |
| Q15 files on disk | ADR-007 |
| Q16 DO truth plus Artifacts history | ADR-008 |
| Q8 layered collision | ADR-009 |
| Q10 trust model | ADR-010 |
| Q11 agent identity | ADR-011 |
| Q6 bind, do not run | ADR-012 |
| Q20 stack | ADR-013 |
| Q13 surfaces | ADR-014 |
| Q4, Q10 intelligent ceiling | ADR-015 |

## Appendix B. Performance Budgets

| Path | Target | Mechanism |
|---|---|---|
| File read (agent) | <1 ms | local materialized directory |
| Edit apply (agent) | <5 ms | local-first optimistic |
| Op propagation | <50 ms (region) | WebSocket, binary ops, batched |
| Collision detection | microseconds | in-memory interval index in the DO |
| Snapshot/connect | seconds | blobless base + lazy hydration |
| Checkpoint | background | never blocks interaction |
