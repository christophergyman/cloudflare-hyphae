# Cloudflare Hyphae - Architecture Decision Record (ADR)

- **Status:** Draft v2 (live file sync)
- **Date:** 2026-10-04
- **Author:** Christopher Man (cman), with opencode
- **Companion:** `docs/hyphae-prd.md`
- **Supersedes:** `docs/archive/hyphae-adr-v1-live-ops.md` (byte-level live-ops design)

---

## Terminology at a glance

| Term | Plain meaning |
|---|---|
| **Repo** | A shared project. One Durable Object (the Hub) plus one Artifacts git repo. |
| **Hub** | A single Durable Object per repo. The live authority: current file versions and who is touching what. |
| **Client** | The small program on each machine that watches files and syncs them to the Hub. |
| **Change** | A file save. |
| **Conflict** | The same file changed in two places at once. Resolved by git merge or the merging agent. |
| **Blob** | The actual file content, stored content-addressed in R2. |
| **Manifest** | The Hub's map of path to current blob version. |
| **Merging agent** | A model, running in an isolated sandbox, that resolves conflicts git cannot and verifies with tests. Never discards work. |
| **Actor** | A human or an agent, with identity, for attribution. |

---

## Part 0. Summary

Hyphae keeps a repo's files in sync live across a team, on Cloudflare, with git history underneath and an AI agent that resolves conflicts. It deliberately does **not** sync at the byte level. It syncs whole files and lets **git** merge, which removes the need to build a real-time merge engine. When git cannot merge, a model resolves the conflict **inside an isolated Cloudflare Sandbox and runs the tests before we accept it.** This is the central decision of the design.

---

## Part 1. System Architecture Overview

### 1.1 Constraints

1. Build on Cloudflare primitives, and on Artifacts for durable versioned storage.
2. Target: teams of engineers each running AI agents on shared code.
3. Solve the collision/merge pain, do not rebuild a real-time editor.
4. Bind agents, do not run them.
5. Blazing fast means one budget that matters: file save to visible on teammates' machines, target under one second.
6. Artifacts is open beta: usable now, still changing.

### 1.2 Component diagram

```
   teammate A (agent/human)                    teammate B (agent/human)
        local files                                local files
            │  file save / file change                   │
            ▼  WebSocket                                 ▼  WebSocket
   ┌──────────────────────────────────────────────────────────┐
   │   EDGE WORKER   auth · routing · API · WS upgrade          │
   └───────────────┬───────────────────────────────┬──────────┘
                   │                               │
        ┌──────────▼──────────┐          ┌─────────▼─────────┐
        │   HUB  (Durable Obj) │          │  R2               │
        │   manifest           │          │  blob content     │
        │   who touches what   │          │  (content-addressed)
        │   conflict detect    │          └───────────────────┘
        │   WebSockets         │
        └──────────┬───────────┘
                   │  starts on conflict
                   ▼
        ┌──────────────────────────┐     ┌───────────────────────────┐
        │  WORKFLOW (durable job)   │────▶│  AI GATEWAY / WORKERS AI   │
        │  1. model merges          │     │  code-capable model        │
        │  2. sandbox runs tests    │     └───────────────────────────┘
        │  3. commit only if green  │
        └──────────┬───────────────┘     ┌───────────────────────────┐
                   │                      │  SANDBOX (Container)       │
                   │                      │  npm ci && npm test        │
                   │                      └───────────────────────────┘
                   ▼
        ┌──────────────────────────┐
        │  RepoStore port           │  (git history, clones, time-travel)
        │   └ Artifacts adapter     │
        └──────────────────────────┘
```

### 1.3 The core loop

```
 file saved locally
   │
   ├─(1) client computes new content hash, compares to last synced hash
   │
   ├─(2) if changed, sends { path, baseHash, content } to the Hub
   │
   ├─(3) Hub compares baseHash to current manifest hash for that path
   │        │
   │        ├─ equal  -> no one else changed it: accept, store blob in R2,
   │        │            update manifest, broadcast, done
   │        │
   │        └─ differ -> someone else changed it: 3-way merge
   │                     base = blob(baseHash)
   │                     ours = content          (your new version)
   │                     theirs = current blob   (their version)
   │                       ├─ clean merge -> accept merged content
   │                       └─ conflict     -> start a Workflow:
   │                                          1. model produces merged file
   │                                          2. sandbox runs build/tests
   │                                          3. pass  -> commit, broadcast
   │                                             fail  -> keep both, surface
   │
   └─(4) Hub broadcasts the new version to other connected clients
```

### 1.4 Why this is simpler than v1

v1 synced byte-range ops and needed a custom engine: operational transform, collision ranges, echo suppression, and a local file interceptor that inferred ops from whole-file writes. Five reviews named that engine the top blocker. v2 removes all of it by syncing whole files and delegating merging to git, escalating only true conflicts to a verified sandbox job.

---

## Part 2. Decisions

### ADR-001: Sync at file level, delegate merging to git

- **Status:** Accepted
- **Context:** Byte-range sync required a hand-built real-time merge engine (op transform, collision ranges, echo suppression) that reviewers flagged as the main blocker. Git already merges files.
- **Decision:** The unit of sync is the whole file. Conflicts are resolved with a standard git 3-way merge (base, ours, theirs), then the merging agent for the hard cases.
- **Rationale:** Reuses git's well-tested merge instead of inventing one. Removes the hardest and most error-prone component.
- **Consequences:** Granularity is coarser. Two agents editing the same file at once becomes a git merge rather than a keystroke merge. Git handles disjoint edits within the same file cleanly, so this is a good trade.

### ADR-002: Layering on Cloudflare; do not rebuild git storage

- **Status:** Accepted
- **Decision:** Artifacts provides durable versioned storage and git history. Hyphae adds the live sync layer, coordination, and surfaces.
- **Consequences:** Depends on an external backend (mitigated by ADR-007).

### ADR-003: One Durable Object (the Hub) per repo is the live authority

- **Status:** Accepted
- **Context:** We need one consistent place that knows the current version of every file and resolves concurrent saves, plus real-time broadcast.
- **Decision:** A single Durable Object per repo holds the manifest (path to blob version), who is touching what, the merge logic, and all client WebSockets.
- **Rationale:** Single authority gives clean conflict resolution and simple broadcast, with no distributed convergence math.
- **Consequences:** A per-repo throughput and memory ceiling. Keep the Hub small: it holds the manifest and coordination, not file content (ADR-004). Sharding is a future option, not built now.

### ADR-004: Hub holds the manifest; blob content lives in R2

- **Status:** Accepted
- **Context:** Durable Objects have roughly 128 MB memory and about 2 MB per stored item. Files can exceed that.
- **Decision:** The Hub stores only a small manifest (path, content hash, version, who, when). **All** file content is stored content-addressed in R2. There is no inline-content threshold: the Hub never stores file bytes.
- **Rationale:** Keeps the Hub fast and small, sidesteps the row and memory limits, and lets the Hub retrieve any past version for merging.
- **Consequences:** Every merge reads blobs from R2. A non-persistent in-memory cache for the few files being actively merged is an optional later optimization, never a store.

### ADR-005: Conflict resolution order: git merge, then agent, then keep both

- **Status:** Accepted
- **Context:** We must resolve concurrent saves without losing work.
- **Decision:** On a conflicting save: (1) try a git 3-way merge; (2) if it fails, ask the merging agent (ADR-014); (3) if the agent is unsure, keep both versions (conflict markers or a conflict copy), surface it, and never discard.
- **Rationale:** Deterministic and cheap first, intelligent second, and a hard floor that always preserves work.
- **Consequences:**
  - The 3-way merge uses a small, pure-JavaScript **diff3** library (for example `node-diff3`), wrapped in `/packages/merge` so it is swappable. It must run in both workerd and Bun, and be covered by property tests.
  - Binary files are never merged (ADR-015).
  - The agent interface is provider-agnostic and optional; the system must work on plain git merge when it is disabled.

### ADR-006: Hub holds live state; Artifacts holds durable history

- **Status:** Accepted
- **Context:** "Files stay in sync" is a live concern; "git history, clones, time-travel" is a durable concern.
- **Decision:** The Hub is the live source of truth. It checkpoints the current state to Artifacts via the RepoStore on **quiescence (about 30 seconds of no changes)**, with a **ceiling of about 5 minutes** while active, plus a **manual trigger**. Never per file. The Hub persists its own un-committed state durably.
- **Rationale:** Two stores doing what each is good at. Dense enough history, cheap against Artifacts pricing, and the un-committed window is bounded.
- **Consequences:** Define Hub restart and replay from the last commit plus persisted state. Checkpoints push small incremental packs to stay under Artifacts push limits.

### ADR-007: RepoStore port with an Artifacts adapter

- **Status:** Accepted
- **Context:** Artifacts is open beta with a moving API and known limits.
- **Decision:** The core depends on a small `RepoStore` interface. Artifacts is the first adapter; a fallback adapter can be added without touching the core. We deliberately **do not** block on an upfront verification spike (Q9): we trust the docs, move fast, and rely on this abstraction if Artifacts disappoints.
- **Consequences:** Keep `RepoStore` minimal.

Proposed surface:

```
createRepo(name) -> Repo
readRef(name, ref) -> CommitHash
readBlob(name, hash) -> bytes
writeCommit(name, parent, tree, message) -> CommitHash
updateRef(name, ref, hash) -> void
```

### ADR-008: Bind agents, do not run them

- **Status:** Accepted
- **Decision:** Agents participate through an MCP server and the CLI. Hyphae never executes agents. Agents edit files normally; the client watcher syncs their changes.
- **Rationale:** Maximizes the agents that can participate and keeps the build small.
- **Consequences:** The MCP surface is a stable contract. Coordination does not depend on agents calling tools; the watcher captures their edits automatically.

### ADR-009: Trust is membership based; identity exists for attribution and revocation

- **Status:** Accepted
- **Decision:** Being in the repo grants trust. No gates. Actors are humans and agents, each with an identity used for attribution (who changed what) and revocation. Agent identities are sponsored by a human.
- **Identity (Q7):** Each actor gets its own **key issued on join**. Every change is signed; the Hub verifies the signature and checks a **removed list** for revocation. Start with **Ed25519 via WebCrypto**, falling back to a per-actor HMAC token if needed. No shared repo password.
- **Rationale:** Simplest model for a trusted team, with attribution and revocation that are real rather than cosmetic.
- **Consequences:** Identity starts lightweight and hardens later. A shared-repo-password model is explicitly rejected.

### ADR-010: Client watcher is a local daemon; ignore your own writes

- **Status:** Accepted
- **Context:** Editors and agents rewrite whole files and fire many events. Incoming changes must not be echoed back.
- **Decision:** The client watches the working folder, debounces events, diffs against its last synced version to find real changes, and records the hash of every write it makes itself so it ignores them.
- **Rationale:** This is the main engineering risk and the main thing to get right; it is bounded because sync is file-level.
- **Consequences:** Needs OS file watching, debouncing, hashing, and echo suppression. First thing to spike. See ADR-016 for offline behavior.

### ADR-011: Stack is TypeScript; Bun on the client

- **Status:** Accepted
- **Decision:** TypeScript everywhere. Workers and Durable Objects on Cloudflare (workerd). Bun for the client CLI and daemon for fast startup. Shared packages use web-standard APIs only so they run in both runtimes.
- **Rationale:** One language, fast path to a working demo. Speed comes from the architecture, not the language; a WASM module remains an option if needed.

### ADR-012: Transport is a WebSocket to the Hub, file-granularity messages

- **Status:** Accepted
- **Decision:** Clients hold a persistent WebSocket to the Hub. Messages are file-level: `change`, `accepted`, `conflict`, `resolved`, `presence`. A snapshot of the manifest is fetched on connect; afterwards only deltas.
- **Rationale:** Simple, cheap, and enough for under-one-second sync.

### ADR-013: Surfaces are CLI, MCP, and a simple live view

- **Status:** Accepted
- **Context:** The demo is the wow: watch teammates' files change live.
- **Decision:** CLI for humans, MCP server for agents, and one simple live view showing connected teammates and files changing in real time.
- **Rationale:** The live view is the demo; it is a thin client of the same WebSocket feed.

### ADR-014: The merging agent is a verified sandbox job

- **Status:** Accepted
- **Context:** Git merge cannot resolve same-line conflicts. We want the resolver to be trustworthy and to prove its work.
- **Decision:** On a true conflict, the Hub starts a **Workflow** that: (1) asks a code-capable generative model, through **AI Gateway** (routed to Workers AI or an external provider), to produce the merged file; (2) boots a **Cloudflare Sandbox (Container)** named per merge, writes the versions, and runs the project's build and tests; (3) commits to Artifacts **only on green**, otherwise keeps both sides and surfaces the failure.
- **Rationale:** Test-verified merges turn "the AI guessed" into "the AI proved it." Workflows give durability and retries; the sandbox gives safe execution of untrusted code.
- **Notes:**
  - This must be a **generative** model. Clef and Jev are decision/classifier models and cannot write merged code, so they are not candidates.
  - `npm install` needs the package registry allowed through an egress handler (or dependencies pre-baked into the image).
  - Keep the model key in the Worker; the sandbox never sees it (egress injects it).
  - One sandbox per merge; never share a sandbox across tasks.
  - Cap model turns/cost and treat repo and test output as untrusted to limit prompt injection.
- **Consequences:** Requires Workers Paid. Container scheduling policy and snapshots are public beta. Cost is cents per merge, dominated by inference.

### ADR-015: Deletes, renames, and binaries

- **Status:** Accepted
- **Decision:**
  - **Delete** = a tombstone change (empty new hash); the path leaves the manifest.
  - **Rename** = delete plus add, with content-hash matching to detect that it is really a rename and avoid a false conflict.
  - **Delete vs edit at once** = the edit wins, the file stays, keep both, surface it. Never lose the edit.
  - **Binaries** = never merge. Detect by content. A single change replaces. A concurrent change to the same binary keeps **both** (a conflict copy) and surfaces it.
- **Rationale:** Sensible, lossless rules without overbuilding rename detection.
- **Consequences:** Binary detection heuristic and conflict-copy naming to be fixed during the build.

### ADR-016: Offline editing queues and merges on reconnect

- **Status:** Accepted
- **Decision:** A disconnected client keeps editing. Changes are written to a **local journal on disk**. On reconnect, the client replays the queued changes with their base hashes; the Hub resolves them through the same git-merge path. Nothing is auto-discarded. If a client has been offline for a very long time, the user is prompted rather than silently overridden.
- **Rationale:** Never blocks work, never loses work.
- **Consequences:** The client needs a durable local journal and a replay path. Define a soft "very long offline" threshold and the prompt behavior during the build.

---

## Part 3. Data Model

```
Repo
  id, name, storeRef, defaultRef, createdAt

Manifest (in the Hub)
  entries: path -> { blobHash, version, updatedBy, updatedAt }

Change
  id, repoId, actorId, path, baseHash, newHash, ts, sig

Conflict
  id, repoId, path, baseHash, oursHash, theirsHash
  status(open|resolving|resolved|kept-both)
  worklowId?

Actor
  id, kind(human|agent), displayName, publicKey, sponsorActorId? (agents)

RemovedActor
  actorId, removedAt        # revocation list checked by the Hub
```

Blobs are content-addressed in R2: `blobHash -> bytes`.

---

## Part 4. Protocols

### 4.1 WebSocket

```
client -> hub:
  hello   { actorId, repoId, manifestSince? }
  change  { id, path, baseHash, content, sig }
  ack     { changeId }

hub -> client:
  manifest { entries }        // on connect or resync
  changed  { path, newHash, version, by }
  conflict { changeId, path, keptBoth? }
  resolved { changeId, path, newHash }
  presence { actors }
```

### 4.2 REST (supporting)

- `POST /repos`, `GET /repos/:name`
- `GET /repos/:name/manifest`
- `GET /blobs/:hash`
- `POST /repos/:name/commit` (force a checkpoint)

### 4.3 Checkpointing

- Trigger: quiescence (about 30s), a ceiling (about 5 min), or manual (ADR-006).
- Action: write the current manifest as a git commit via `RepoStore`, update the ref.
- Recovery: reload the last commit plus the Hub's persisted un-committed state.

---

## Part 5. Repository Layout

```
/apps
  /cli            Bun + TS    human CLI and the local daemon (watcher + sync + journal)
  /mcp            TS          MCP server for agents
  /web            TS          simple live view
/workers
  /edge           TS          auth, routing, REST, WebSocket upgrade
  /hub-do         TS          the Hub Durable Object
  /merge-workflow TS          Workflow: model merge + sandbox verify + commit
/packages
  /core           TS          domain: Repo, Manifest, Change, Conflict, Actor
  /merge          TS          diff3 merge + merging-agent interface (runtime-agnostic)
  /repostore      TS          RepoStore port + Artifacts adapter
  /protocol       TS          WebSocket and REST schemas (shared, versioned)
/infra
  wrangler.toml, R2 bucket, Container/Dockerfile, Workflow + AI Gateway config
/docs
  hyphae-prd.md, hyphae-adr.md, archive/
```

---

## Part 6. Cloudflare Primitive Mapping

| Need | Primitive |
|---|---|
| Durable versioned storage, git history, clones | **Artifacts** |
| Live per-repo authority, sync, WebSockets | **Durable Objects** |
| Edge API, auth, routing | **Workers** |
| Blob content, snapshots | **R2** |
| Durable merge job (resolve + verify + commit) | **Workflows** |
| Model calls (code-capable) | **Workers AI** via **AI Gateway** |
| Isolated space to resolve and run tests | **Sandboxes / Containers** |
| Metadata, attribution (later) | **D1** |
| Agent participation | **MCP server + CLI** |

---

## Part 7. Resolved Decisions and Remaining Questions

### 7.1 Resolved (from the v2 open-questions round)

| # | Question | Resolution |
|---|---|---|
| Q1 | Blob threshold / Hub caching | Hub holds only the manifest; all content in R2; no threshold (ADR-004) |
| Q2 | 3-way merge library | Small pure-JS diff3 (for example `node-diff3`), wrapped and swappable (ADR-005) |
| Q3 | Merging agent | Generative model + test-verifying Sandbox via Workflow; commit only on green (ADR-014) |
| Q4 | Checkpoint cadence | Quiescence ~30s, ceiling ~5 min, plus manual (ADR-006) |
| Q5 | Deletes and renames | Tombstone delete; content-hash rename detection; edit wins (ADR-015) |
| Q6 | Offline behavior | Local journal, replay and merge on reconnect, never auto-discard (ADR-016) |
| Q7 | Identity for MVP | Per-actor key on join, signed changes, removed list (ADR-009) |
| Q8 | Binary files | Never merge; replace; keep both on concurrent change (ADR-015) |
| Q9 | Artifacts limits | Trust the docs, move fast; RepoStore swap seam is the fallback (ADR-007) |

### 7.2 Remaining open questions (to resolve during the build)

1. **Test command detection:** how the merge Workflow decides what to run (package.json scripts, a per-repo config, or a fallback to build only).
2. **Model choice:** which code model for the first cut, and the exact merge prompt contract and confidence signal.
3. **Binary detection:** the exact heuristic.
4. **Hub restart/replay:** the tested procedure from the last commit plus persisted state.
5. **Sandbox cost controls:** turn and cost caps, and when to fall back to keep-both.
6. **"Very long offline" threshold:** the number and the prompt behavior.
7. **Artifacts limits confirmation:** validate large-push behavior and per-repo storage while building (Q9 chose to defer the spike).

---

## Part 8. What Changed From v1

| v1 (byte-level live ops) | v2 (file-level live sync) |
|---|---|
| Custom op transform engine | Git 3-way merge |
| Byte-range collision detection | Per-file conflict detection |
| Local file interceptor inferring ops | File watcher sending whole files |
| Echo suppression via op baseline | Echo suppression via write hash |
| Task mesh, event-sourced signals | Manifest plus per-file versions |
| Merge resolved by intelligence alone | Merge verified by tests in a sandbox |
| Hardest parts = the sync engine | Hardest part = the client watcher |

v1 is preserved at `docs/archive/hyphae-adr-v1-live-ops.md`.
