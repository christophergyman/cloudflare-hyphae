# Cloudflare Hyphae - Build Plan

- **Status:** Draft
- **Date:** 2026-10-04
- **Author:** Christopher Man (cman), with opencode
- **Basis:** `docs/hyphae-prd.md`, `docs/hyphae-adr.md`, `docs/hyphae-stack.md`, `docs/hyphae-context.md`
- **Purpose:** Turn the spec into an ordered, checkpointed build sequence. Every phase ends in something demonstrable.

This plan does not change the design. It schedules it. If the plan and the ADR ever disagree, the ADR wins until a new decision is recorded.

---

## How to read this plan

- **Phases** are ordered by risk. The scariest things come first, so surprises surface early.
- **Every phase has a checkpoint.** A checkpoint is a hard gate: you may not start the next phase until its criteria are all true and you can demo it.
- **Two milestone lines** mark partial completion:
  - **Demo line:** the minimum needed to show the wow (two agents, one file, zero human merges, live).
  - **MVP line:** the full scope in the PRD (CLI, MCP, live view, simple identity).
- **Estimates** are rough and assume focused effort with agents helping. Treat them as relative sizes, not promises.

### Checkpoint format

Each checkpoint answers three questions:

- **You can demonstrate:** a concrete, visible thing.
- **Exit criteria:** a list that must all be true (tests green, behavior observed).
- **Gate:** what unblocks once it passes.

### Size legend

`XS` under half a day, `S` about a day, `M` a few days, `L` a week or more.

---

## Build status

- **Phase 0 in progress.** The foundation is shipped.
- **Done:** Bun workspaces monorepo, the contract packages (`core`, `protocol`, `repostore`, `merge`) with tests, the edge Worker skeleton, and spike 1.
- **Spike 1 (Artifacts write path):** isomorphic-git commit and push over smart HTTP proven locally, including an incremental commit and clone-back. Only the Artifacts host and token auth remain, and they need a Workers Paid account. See `spikes/artifacts-push/README.md`.
- **Next:** the remaining Phase 0 spikes (Agents SDK Hub, `ctx.container`, R2 presign, AI Gateway, Ed25519), then Checkpoint 0.

---

## 1. Guiding principles for the build

1. **Retire risk first.** The client watcher (ADR-010) and the merge core (ADR-005) are the risk. Build and prove them before anything pretty.
2. **Every phase ends demoable.** No phase is "infrastructure only." Something runs at the end.
3. **Keep the seams.** `RepoStore` (ADR-007) and `packages/merge` stay swappable. Do not leak Artifacts or the diff3 library into the core.
4. **Never lose work, including in the build.** Supersede and archive docs instead of deleting. Keep failing experiments with a note.
5. **Save before broadcast.** Persist, then announce. Dedupe by change id (from the review findings).
6. **Docs stay in sync.** Any real decision becomes an ADR amendment in the same change.
7. **Measure the one number that matters.** File save to visible on the other machine. If it is not under a second, stop and fix it before moving on.

---

## 2. Phase map

```
Phase:   0      1      2      3      4      5      6  |  7      8  |  9      10
       ┌─────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
       │ fnd │ mrg  │ hub  │ wchr │ hist │ agnt │ surf │ hard │ demo │ moat │ scale│
       └─────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┘
                                          ▲      ▲              
                                     demo line  MVP line
                                  (Phases 0-5)  (Phases 0-6)

Sizes:  S     S     M       L     S-M     M     M      M      S     ongoing
```

- **Phases 0 to 5:** the core. End state is the wow: live sync plus a verified AI merge.
- **Phase 6:** the ships: CLI, MCP, live view. This is the MVP line.
- **Phases 7 to 8:** hardening and the demo night.
- **Phases 9 to 10:** the moat and scale, after the MVP proves itself.

---

## 3. Phase details

### Phase 0: Foundations and contracts (`S`)

**Goal:** A monorepo that builds, tests, and deploys nothing of value yet, but sets every seam in place.

**Why now:** Every later phase depends on shared types and the `RepoStore` boundary. Getting these wrong is expensive to undo.

**Deliverables**

- Bun workspaces monorepo matching the ADR layout (Part 5). Concrete tools are pinned in `docs/hyphae-stack.md`.
- `packages/core`: domain types (`Repo`, `Manifest`, `Change`, `Conflict`, `Actor`) plus the metrics module (Analytics Engine).
- `packages/protocol`: versioned WebSocket and REST message schemas (from ADR Part 4), including the presigned blob endpoints.
- `packages/repostore`: the `RepoStore` port plus two adapters, an in-memory one and an R2 one.
- `wrangler.toml` with R2 bucket binding, an Agents SDK `Agent` binding, and an Artifacts binding.
- Tooling: TypeScript config, Biome, the test runners, a `dev` script.
- `infra/` layout for the Container image, Workflow, AI Gateway, and Analytics Engine config (empty but present).

**Tasks**

1. Scaffold workspaces and shared TS config.
2. Write the domain types and the protocol schemas first, as the contract everything codes against.
3. Define the `RepoStore` interface exactly as ADR-007 (keep it minimal).
4. Implement the in-memory adapter and the R2 adapter.
5. Bind Artifacts and stand up a hello Worker plus a stub Agents SDK `Agent` with `wrangler dev`.

**Spikes (time-boxed, run in parallel, results feed the ADRs)**

1. **isomorphic-git commit and push to Artifacts from a Worker** (ADR-018). The biggest unknown.
2. **Agents SDK `Agent` as the Hub** carrying our two-client sync protocol (ADR-017).
3. **`ctx.container` plus a snapshot**, running `npm ci && npm test` with an egress allowlist (ADR-014).
4. **R2 presigned PUT/GET** round trip from the client (ADR-020).
5. **AI Gateway** to a frontier model with a Workers AI fallback and a Secrets Store key (ADR-021).
6. **Ed25519** sign/verify in workerd, or confirm `@noble/ed25519` (ADR-009).

> **Checkpoint 0: The skeleton stands**
> - **You can demonstrate:** `bun test` passes across all packages, `wrangler dev` boots a Worker that hits the R2 adapter, the `RepoStore` interface is frozen, and each spike has a yes/no answer recorded.
> - **Exit criteria:** types compile; in-memory and R2 adapters both pass the same port test suite; protocol schemas have version numbers; the six spikes are resolved.
> - **Gate:** Phases 1 to 6 can now code against stable contracts.

**Risks:** Over-engineering the types, and beta churn in the Agents SDK, Containers, and Dynamic Workers. Keep them behind seams.

---

### Phase 1: The merge core (`S`)

**Goal:** A pure, runtime-agnostic 3-way merge that runs identically in Bun and workerd.

**Why now:** This is the heart of conflict handling (ADR-005) and it is cheap and low risk. Do it before the Hub so the Hub can call it.

**Deliverables**

- `packages/merge`: wrap a pure-JS `diff3` library behind our own small API.
- `mergeFile(base, ours, theirs) -> { clean: true, content } | { clean: false, conflicts }`.
- Binary detection heuristic (first cut; refine in Phase 7).
- A large fixture suite: disjoint edits, same-line conflicts, insertions, deletions, whitespace, CRLF, unicode, empty files.

**Tasks**

1. Choose and vendor the diff3 library (for example `node-diff3`) behind our API.
2. Implement clean-merge and conflict-reporting paths.
3. Add property-based tests: any merge that reports clean must contain both sides' disjoint changes.
4. Prove it runs under both Bun and workerd (a tiny workerd smoke test).
5. Add the binary detection heuristic and tests.

> **Checkpoint 1: Merge is trustworthy**
> - **You can demonstrate:** a script that merges a base with two conflicting versions and prints either a clean result or explicit conflict regions.
> - **Exit criteria:** property tests pass; the same module runs in Bun and workerd; binary files are refused, not garbled.
> - **Gate:** the Hub can call `mergeFile` with confidence.

**Risks:** Library quirks around line endings and unicode. Nail these in fixtures, not in production.

---

### Phase 2: The Hub and the live loop (`S-M` with the Agents SDK, `M` without)

**Goal:** The live authority for one repo, built on the Agents SDK, with a working sync loop and broadcast.

**Why now:** This is the single-authority core (ADR-003) that everything else talks to. The Agents SDK (ADR-017) should shrink this phase.

**Deliverables**

- `workers/hub-do`: the Hub, as an Agents SDK `Agent` (ADR-017).
  - Holds the manifest (`path -> { blobHash, version, updatedBy, updatedAt }`) in SQLite-backed DO storage (ADR-019).
  - Handles `hello`, `change`, `ack`; emits `manifest`, `changed`, `conflict`, `resolved`, `presence` (ADR-012).
  - Accepts a change whose content is already in R2 (ADR-020), updates the manifest, broadcasts.
  - On a stale `baseHash`, runs `mergeFile`, accepts a clean merge, or marks a conflict.
  - Uses hibernating WebSockets and persists state across hibernation (ADR-019).
- `workers/edge`: auth stub, routing, REST endpoints, WebSocket upgrade, and the R2 presign endpoint (ADR-020).
- Presence: who is connected, who touched what, from `ctx.getWebSockets()`.

**Tasks**

1. Implement the manifest and change handling, persist before broadcast, dedupe by change id.
2. Wire the WebSocket protocol end to end on the `Agent` class.
3. Add the conflict path that calls `packages/merge`.
4. Add REST: `POST /repos`, `GET /repos/:name/manifest`, `POST /repos/:name/blobs/presign`.
5. Integration tests with the Cloudflare Vitest integration: two WebSocket clients, one repo, sync and conflict.

> **Checkpoint 2: Two clients, one Hub**
> - **You can demonstrate:** two scripted WebSocket clients editing the same repo through the Hub. One writes, the other receives. A stale write that is disjoint merges cleanly; a same-line write yields a conflict. Blobs move via R2, not the WebSocket.
> - **Exit criteria:** integration tests pass; a Hub restart reconstructs the manifest; blobs land in R2 content-addressed; the `Agent` carries our protocol without fighting it.
> - **Gate:** the client watcher has a real server to talk to.

**Risks:** Whether our custom protocol fits the Agents SDK cleanly; if not, the hot path drops to the raw Durable Object API. Test reconnect, hibernation, and duplicate delivery explicitly.

---

### Phase 3: The client watcher and daemon (`L`, the risk)

**Goal:** A local daemon that watches a folder, detects real changes, syncs them, and ignores its own writes. This is the hardest and most important piece (ADR-010).

**Why now:** This is the main engineering risk. If it cannot be made reliable, nothing else matters.

**Deliverables**

- `apps/cli`: the local daemon (watcher plus sync plus a journal scaffold).
  - OS file watching with debounce.
  - Hash each file; compare to the last synced hash to find real changes.
  - Record the hashes of its own writes to suppress echoes.
  - Apply remote changes atomically (write temp, then rename) to avoid readers seeing half a file.
  - Reconnect with backoff.
- A **minimal live view** pulled forward from Phase 6, purely as a debug surface: connected actors and files changing.

**Tasks**

1. Watch a folder and log normalized change events after debounce.
2. Diff against last synced state to find genuine edits.
3. Echo suppression via own-write hash set.
4. Upload changed content to R2 via a presigned URL, send the hash to the Hub (ADR-020), and apply received changes atomically.
5. Stress it: a script that writes many files rapidly, an editor autosave loop, a large file.
6. Prove no echo loop and no lost change under churn.

> **Checkpoint 3: It moves live (the demo backbone)**
> - **You can demonstrate:** two machines (or two folders) running the daemon. Edit a file on A, watch it appear on B in under a second. Edit on B, watch it appear on A. No echo storms. Edit the same file on both, disjoint, and it merges.
> - **Exit criteria:** measured save-to-visible under one second on a LAN; no echo loop over a sustained churn test; no change lost.
> - **Gate:** the demo is now real. Everything after this is quality and trust.

**Risks:** The whole project. Platform differences in file watching, editors that rewrite files, symlinks, permissions. Budget extra time here and keep failing cases.

---

### Phase 4: Durable history and checkpoints (`S-M`)

**Goal:** Real git history falls out of the live session, with a tested recovery path.

**Why now:** Until now the Hub is the only truth. This makes the work durable and cloneable (ADR-006, ADR-007).

**Deliverables**

- The Artifacts adapter implementing `RepoStore`: the binding for lifecycle and reads, **isomorphic-git** in the Worker to commit and push (ADR-018).
- Checkpoint scheduler in the Hub (Agents SDK scheduling over DO alarms): quiescence about 30 seconds, ceiling about 5 minutes, plus a manual trigger.
- `POST /repos/:name/commit` forced checkpoint.
- Hub restart and replay from the last commit plus persisted state.
- A `git clone` verification path.

**Tasks**

1. Implement the Artifacts adapter against the frozen `RepoStore` port.
2. Build the checkpoint scheduler and push incremental packs.
3. Implement restart/replay (this resolves open question 4).
4. Verify: clone the repo after a session and inspect real history; restart the Hub mid-session and confirm no loss.

> **Checkpoint 4: Real history underneath**
> - **You can demonstrate:** after a burst of live edits, `git clone` yields a repo with a sensible commit history; kill the Hub, restart it, and the session continues with nothing lost.
> - **Exit criteria:** checkpoint cadence observed in logs; clone works; replay test passes; Artifacts large-push behavior validated (this closes open question 7).
> - **Gate:** the product is durable, not just live.

**Risks:** Artifacts beta limits and the reported large-push bug. The `RepoStore` seam is the fallback if it bites.

---

### Phase 5: The verified merge agent (`M`)

**Goal:** Same-line conflicts get resolved by a model that proves its work by running the tests.

**Why now:** This is the trust layer and the differentiator (ADR-014). The demo is not complete without it.

**Deliverables**

- `workers/merge-workflow`: a Workflow that:
  1. Takes a conflict (base, ours, theirs).
  2. Calls a generative code model through **AI Gateway** (frontier model primary, Workers AI fallback, key from Secrets Store, ADR-021).
  3. Boots a per-merge **Container via `ctx.container`** (`durable_object` policy, restored from a warm **snapshot**), writes the candidate, runs build/tests.
  4. Commits and broadcasts **only on green**; otherwise keeps both and surfaces.
- A **Dynamic Workers fast path** for JS/TS projects where a full container is overkill (ADR-014 notes).
- Test command detection (this resolves open question 1): read `package.json` scripts or a per-repo config, fall back to build only.
- Model choice and prompt contract with a confidence signal (this resolves open question 2).
- Cost and turn caps with a keep-both fallback (this resolves open question 5).
- Conflict surfacing: markers or a conflict copy, never silent.

**Tasks**

1. Build the Container image with dependencies, and create a snapshot for warm starts (ADR-014).
2. Allow the package registry through an egress handler (or pre-bake dependencies).
3. Keep the model key out of the container (Secrets Store via AI Gateway, or edge-injected egress).
4. Build the Workflow steps with retries and durable state.
5. Implement the green-only commit rule and the keep-both fallback.
6. Add the Dynamic Workers fast path for JS/TS and measure where it is sufficient.
7. Test: a cleanly resolvable same-line conflict, and a conflict whose merge fails tests.

> **Checkpoint 5: The AI proves it (the hero moment)**
> - **You can demonstrate:** two clients change the same lines of a file. The conflict goes to the Workflow, the model produces a merge, the container runs the tests, and on green both machines converge on the verified result. Then show a case where tests fail and both sides are kept.
> - **Exit criteria:** green commit path works; failing path keeps both and surfaces; cost per merge measured in cents; one container per merge enforced; warm starts from a snapshot.
> - **Gate:** the demo line is reached. The wow is complete.

**Risks:** Container cold start (mitigated by snapshots), npm egress, prompt injection from repo contents. Cap output and gate on tests.

---

### Phase 6: Surfaces, the MVP line (`M`)

**Goal:** The three surfaces in ADR-013, polished enough to hand to someone else.

**Why now:** MVP scope in the PRD requires CLI, MCP, and a live view.

**Deliverables**

- `apps/cli`: `init`, `join`, `up`, `status`, `log`. Human-friendly output.
- `apps/mcp`: an MCP server on the Agents SDK (`McpAgent` / `createMcpHandler`, ADR-017) exposing repo state, history, presence, and checkpoint tools so any agent harness can participate without changing its workflow.
- `apps/web`: the live view, a thin client of the same WebSocket feed (connected actors, files changing, merges, tests passing, recent commits).

**Tasks**

1. Finish the CLI around the Phase 3 daemon.
2. Implement the MCP server with the Agents SDK against the stable protocol.
3. Polish the live view for the big screen.
4. End-to-end test: a real agent harness edits files and the changes flow with no Hyphae-specific tooling.

> **Checkpoint 6: It is a product, not a spike (MVP line)**
> - **You can demonstrate:** a new person can join a repo with the CLI, an agent participates via MCP, and the live view shows the whole session.
> - **Exit criteria:** all three surfaces work; PRD MVP in-scope list is fully met; the acceptance demo is rehearsable.
> - **Gate:** hardening and demo prep begin.

**Risks:** Scope creep in the CLI or live view. Keep them thin clients.

---

### Phase 7: Hardening (`M`)

**Goal:** Close the accepted risks and loose ends so this can survive real use.

**Why now:** These are known gaps from the reviews. Cheap to close once the core works.

**Deliverables**

- **Identity (ADR-009, Q7):** per-actor key on join (`@noble/ed25519`, WebCrypto if verified, HMAC fallback), signed changes, Hub verification, a removed list for revocation.
- **Offline (ADR-016, Q6):** durable local journal, replay and merge on reconnect, a soft "very long offline" prompt (this resolves open question 6).
- **Deletes and renames (ADR-015, Q5):** tombstones, content-hash rename detection, edit-wins on delete-vs-edit.
- **Binaries (ADR-015, Q8):** replace, keep both on concurrent change, conflict-copy naming.
- **Abuse resistance (ADR-023):** the Workers rate limiting binding per actor and per repo, AI Gateway model limits, and XSS-safe rendering on the live view.
- **Security loose ends (from `hyphae-context.md`):**
  - Path-jail the client (reject `..`, absolute paths, symlink escapes, dangerous files like `.git/hooks`).
  - Secret scanning at intake with a narrow redaction exception that keeps a tombstone.
  - Keep the backing git remote read-only for members; only the Hub writes.

**Tasks**

1. Identity: issue, sign, verify, revoke.
2. Offline journal and replay, tested by disconnecting mid-edit.
3. Delete/rename/binary rules with tests.
4. Path jail, secret scan, read-only remote.
5. Add rate limiting per actor and per repo (ADR-023).
6. Binary detection heuristic finalized (open question 3).

> **Checkpoint 7: It holds up**
> - **You can demonstrate:** an unsigned or removed actor is rejected; an offline laptop reconnects and merges without loss; a delete-vs-edit keeps the edit; a client is blocked from writing outside the project.
> - **Exit criteria:** all hardening tests pass; the accepted-risk list in `hyphae-context.md` is closed or explicitly re-accepted with a note.
> - **Gate:** release readiness.

**Risks:** Identity crypto in workerd. Use `@noble/ed25519` to avoid depending on WebCrypto Ed25519; the HMAC fallback covers gaps.

---

### Phase 8: Demo and launch (`S`)

**Goal:** Land the demo and the story.

**Deliverables**

- `docs/hyphae-demo.md`: the locked demo script (the acts in the vision).
- A seed repo and a rehearsal run with timing.
- Updated docs: PRD/ADR/plan brought in sync with what was built.
- The Cloudflare "next Git platform" competition submission (deadline October 14), if timing holds.

**Tasks**

1. Write the demo script and rehearse it end to end.
2. Record a fallback video in case live fails.
3. Finalize docs and commit history.
4. Submit if the window is open.

> **Checkpoint 8: Show time**
> - **You can demonstrate:** the full demo, live, timed: two agents, one file, disjoint edits merge, same-line edits resolved and verified, a failure case keeping both, and a clean `git log` at the end.
> - **Exit criteria:** rehearsal completes with zero human merges and zero lost work; fallback video exists.
> - **Gate:** public launch or submission.

---

### Phase 9: The moat layer (post-MVP, ongoing)

**Goal:** Turn the verified merge loop into a compounding advantage.

**Deliverables**

- Every merge is logged: inputs, model output, test result, and human disposition if any.
- A merge-record store (Analytics Engine for metrics, R2 or R2 SQL for the records) and a simple report of verification rate.
- A path to improve the merge model from the record (fine-tune or retrieval with Vectorize).
- A metric: verified-merge success rate over time.

**Tasks**

1. Instrument the Workflow to emit a durable merge record.
2. Build a report: how often merges pass tests, where the agent falls back.
3. Close the loop: feed verified examples back into prompt or model selection.

> **Checkpoint 9: The flywheel turns**
> - **You can demonstrate:** a report showing merges attempted, verified, and fallen back, with the data stored for later training.
> - **Exit criteria:** 100 percent of merges are recorded; a human can inspect any record.
> - **Gate:** iterate on merge quality with real evidence.

---

### Phase 10: Scale and breadth (post-MVP, deferred)

**Goal:** The things we consciously did not build yet. Revisit only with demand.

- **Throughput:** sharding the Hub if one Durable Object is the ceiling (ADR-003).
- **Multi-repo and cross-repo awareness.**
- **GitHub / GitLab bridge.**
- **D1 metadata layer** for attribution and analytics.
- **Abuse resistance (remaining):** runaway-agent auto-pause, broader CI isolation, and hardening beyond the ADR-023 baseline.
- **Moat analytics and retrieval:** R2 Data Catalog, Pipelines, R2 SQL, Vectorize, AI Search.

> **Checkpoint 10: Scoped and deferred**
> - **You can demonstrate:** a written decision on which of these is next and why.
> - **Exit criteria:** an ADR records the priority order.

---

## 4. Checkpoints summary

| # | Name | Phase | You can demonstrate | Line |
|---|---|---|---|---|
| 0 | The skeleton stands | 0 | Tests pass, Worker boots, contracts frozen | |
| 1 | Merge is trustworthy | 1 | Clean merge or explicit conflicts, in Bun and workerd | |
| 2 | Two clients, one Hub | 2 | Scripted clients sync and conflict through the Hub | |
| 3 | It moves live | 3 | Two folders sync a file in under a second, no echo | Demo backbone |
| 4 | Real history underneath | 4 | `git clone` shows history; Hub restart loses nothing | |
| 5 | The AI proves it | 5 | Conflict resolved by model, verified by tests; failure keeps both | **Demo line** |
| 6 | It is a product | 6 | CLI, MCP, live view all work | **MVP line** |
| 7 | It holds up | 7 | Identity, offline, deletes, security loose ends closed | |
| 8 | Show time | 8 | Timed live demo, zero human merges | Launch |
| 9 | The flywheel turns | 9 | Every merge recorded, verification report | Moat |
| 10 | Scoped and deferred | 10 | Written priority for scale work | |

---

## 5. Risk register

| Risk | Phase | Mitigation | Where retired |
|---|---|---|---|
| Client watcher echo loops or drops changes | 3 | Debounce, own-write hash, stress tests, atomic apply | Checkpoint 3 |
| Merge library edge cases (CRLF, unicode, binary) | 1 | Fixtures and property tests before the Hub uses it | Checkpoint 1 |
| Durable Object throughput or memory ceiling | 2, 10 | Manifest only in the Hub; sharding is a future option | Checkpoint 2, deferred |
| Artifacts beta limits or push bug | 4 | `RepoStore` seam, incremental packs | Checkpoint 4 |
| Container cold start, npm egress, cost | 5 | Warm snapshots, egress rules, per-merge container, cost caps | Checkpoint 5 |
| Prompt injection from repo or test output | 5, 7 | Cap output, gate on green tests, optional human approval | Checkpoints 5, 7 |
| Identity crypto in workerd | 7 | `@noble/ed25519` or WebCrypto, HMAC fallback | Checkpoint 7 |
| Beta churn (Agents SDK, Containers, Dynamic Workers) | 2 to 6 | Keep each behind a seam (`RepoStore`, merge verifier, protocol) | Continuous |
| Scope creep in surfaces | 6 | Keep CLI and live view thin clients | Checkpoint 6 |
| Copyable design, no durable moat | 9 | Compound the verified-merge dataset | Checkpoint 9 |
| Loss of work anywhere in the system | all | Save before broadcast, keep both, never auto-discard | Every checkpoint |

---

## 6. Open questions and loose ends, mapped to phases

From the ADR Part 7.2 and `hyphae-context.md`. Each one gets resolved in a specific phase.

| Item | Resolved in |
|---|---|
| 1. Test command detection | Phase 5 |
| 2. Model choice and prompt contract | Phase 5 |
| 3. Binary detection heuristic | Phase 7 |
| 4. Hub restart and replay | Phase 4 |
| 5. Container cost controls | Phase 5 |
| 6. "Very long offline" threshold | Phase 7 |
| 7. Artifacts limits confirmation | Phase 4 |
| 8. Agents SDK protocol fit | Phase 0 spike, Phase 2 |
| 9. Artifacts write path (isomorphic-git push) | Phase 0 spike, Phase 4 |
| 10. Container API (`ctx.container` vs legacy) | Phase 0 spike, Phase 5 |
| 11. Identity crypto (Ed25519) | Phase 0 spike, Phase 7 |
| 12. Blob inline threshold | Phase 0 spike, Phase 2 |
| Loose end: path-jail the client | Phase 7 |
| Loose end: secret scanning and redaction | Phase 7 |
| Loose end: read-only git remote for members | Phase 7 |
| Loose end: revert semantics | Phase 7 (or deferred) |
| Abuse resistance baseline (ADR-023) | Phase 7 |

---

## 7. Definition of done (MVP)

The MVP is done when all of the following are true:

1. A repo backed by Artifacts can be created and joined from the CLI.
2. Two or more machines stay in sync live via the Hub, under one second on a LAN.
3. No-conflict saves land instantly.
4. Same-file disjoint edits merge automatically with git, no human.
5. Same-line conflicts are resolved by the merging agent and verified by tests, or both sides are kept and surfaced.
6. Work is committed to Artifacts on the checkpoint cadence, with real `git clone` history.
7. CLI, MCP server, and live view all work.
8. The acceptance demo passes: two agents edit the same file's different sections at once, live, zero human merges, nothing lost.

---

## 8. What is explicitly not in this plan

Kept out of scope on purpose, to protect the MVP:

- Byte-level or keystroke sync (ADR-001).
- CRDTs or operational transform.
- A task mesh or event-sourced task graph.
- A full web forge (issues, PRs, review UI).
- Multi-repo, cross-repo awareness.
- A GitHub or GitLab bridge.
- Clef or Jev as the merging agent (they cannot generate code).

The rejected v1 design stays archived at `docs/archive/` and is not revived without a new decision.

---

## 9. Working agreements

- **Docs are the spec.** Update an ADR in the same change as any real decision.
- **Checkpoints are gates, not suggestions.** Do not advance on a broken checkpoint.
- **Keep the seams.** `RepoStore` and `packages/merge` stay swappable.
- **Prove it or keep both.** Anything unverified falls back to keeping both sides.
- **One number.** If save-to-visible is not under a second, stop and fix it.
