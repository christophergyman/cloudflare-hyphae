# Cloudflare Hyphae - Product Requirements Document

- **Status:** Draft v0.1
- **Date:** 2026-10-04
- **Author:** Christopher Man (cman), with opencode
- **Companion doc:** Architecture Decision Record (ADR), to be written next

---

## 1. Overview

Hyphae is a coordination and collaboration layer for software teams where every engineer runs one or more AI coding agents against shared code. It replaces the git branch plus deferred-merge workflow with a shared, live workspace where agents and humans see each other's work as it happens, fuse non-conflicting changes continuously, and surface collisions immediately instead of at merge time.

Hyphae is built as an abstraction layer on top of **Cloudflare Artifacts** (git-compatible versioned storage) and other Cloudflare primitives, not as a replacement for them.

**One-line pitch:** *Your team's agents stop conflicting, live.*

**The metaphor:** Git is a mycelium that branches but never fuses. Hyphae is a true mycelium, where filaments anastomose (fuse) continuously, so the whole network shares its work in real time.

---

## 2. Background and Motivation

### 2.1 The problem with git in the AI era

Git was designed for humans working in long-lived, isolated branches, integrating rarely through merges. With agents, that model breaks down:

- **Conflict is deferred to the worst moment.** Branches hide work until integration, when context is most expensive to rebuild.
- **Nobody can see in-flight work.** Two engineers (or their agents) cannot see each other's uncommitted changes, so collisions are guaranteed and discovered late.
- **Integration is serialized through humans.** Every parallel effort funnels through a PR and a human merge.
- **Agents give up rather than resolve conflicts.** Research (Chroma, "Agent Swarms are a Distributed Systems Problem") measured 3/8 agents abandoning work rather than fighting a merge, wasting expensive reasoning.

### 2.2 Prior art and landscape

- **Cloudflare Artifacts (April 2026):** git-compatible versioned storage built for agents, on Durable Objects + R2 + KV, with a Zig/WASM git server. This *solves* the "git storage on Cloudflare" problem, so Hyphae does not rebuild it.
- **Chroma "Fission":** argues that for agents, aborting and retrying throws away expensive reasoning, and that git is terrible at resolving conflicts. The fix is early-commit, per-writer isolation, and no rollback. Hyphae adopts the philosophy but targets code and teams, not wiki knowledge.
- **System One decision models (Jev, Cloudflare Clef):** cheap, fast classifiers that can serve as advisory judgment in the intelligent layer.
- **Jujutsu / Pijul / mergiraf:** prior art for treating conflict as a first-class object, patch commutation, and syntax-aware merge.

### 2.3 The gap Hyphae fills

The storage and protocol layers are now commodities. Nothing well-solved exists for the layer above them: **coordination among many concurrent writers (humans plus agents) with continuous fusion and no lost work.** That is Hyphae.

---

## 3. Problem Statement

A team of engineers, each running multiple AI agents against a shared repository, cannot coordinate their combined work. Git isolates work into branches and defers all conflict to merge time, forcing humans to be the integration bottleneck and causing agents to discard valuable work. There is no shared, real-time view of who is changing what, and no mechanism to fuse concurrent work continuously and safely.

---

## 4. Target Users and Personas

### 4.1 Primary user: the engineering team with agents

- Small teams (2 to 10) where each engineer runs one or more coding agents.
- Example (the founding scenario): cman and Saad, each running a couple of agents, constantly conflicting on shared code.
- They think in tickets/issues, not branches. They want to stop being the merge bottleneck.

### 4.2 Secondary user: the agent (as a participant)

- Any coding harness (Claude Code, Codex, OpenCode, custom) that can join a Task, see signals, claim scope, and propose changes.
- Agents are first-class participants, not hidden tools.

### 4.3 Future user: the platform builder

- Teams and products that want to build on Hyphae as a primitive via API/SDK.

**Design rule:** solve for teams, and solo falls out for free.

---

## 5. Goals and Non-Goals

### 5.1 Goals

1. Eliminate deferred merge conflicts for a team running concurrent agents.
2. Provide live, truthful visibility of who is changing what.
3. Fuse concurrent work continuously, without discarding any computed work.
4. Make both humans and agents first-class participants in one shared workspace.
5. Be a durable primitive that keeps working as models get more capable, without core changes.

### 5.2 Non-Goals (product level)

1. Rebuilding git storage or the git wire protocol (Artifacts owns this).
2. Running or orchestrating agents ourselves (we bind, we do not run).
3. Being a generic chat/agent runtime or model provider.
4. A CRDT research project. We use one deterministic referee, not distributed convergence math.
5. Full permissions/roles/ACLs. Membership is the trust boundary.

---

## 6. Core Concepts

| Concept | Definition |
|---|---|
| **Repo** | A shared coordinate space. Maps to one Artifacts repository. |
| **Task** | A unit of intent ("add SSO"). The primary unit of coordination. A node in a **mesh**: it can branch (sub-tasks) and fuse (merge with other tasks). |
| **Actor** | A human or an agent. Agents are first-class, sponsored by a human. |
| **Workspace** | The isolated-but-visible view a Task writes into (a live overlay). |
| **Signal** | The atomic primitive: an immutable, append-only event (claim, change, warning, request, decision). Event-sourced. |
| **Claim** | A Signal declaring intent to touch a scope (paths/regions). The stigmergic "chemical deposit." |
| **Change** | A set of region ops plus provenance, proposed for fusion. |
| **Overlay** | A Task's ordered op log applied on top of the base snapshot. |
| **Referee** | The Durable Object. Deterministic: order, truth, atomicity, undo. |
| **Council** | (Future) A layer of observer agents (reconciler, sentinel, reviewer, allocator) that read signals and propose actions. |

### 6.1 Task lifecycle

```
Open  ──►  Active  ──►  Settled  ──►  Closed
 intent     actors        no active      retracted /
 defined    attached,     writers;       recycled
            workspace     changes fused;
            live          checkpointed
```

Orthogonal flags (can be on at any time):

- **colliding:** an unresolved overlap exists.
- **contested:** actors disagree; the Council is mediating.
- **quarantined:** a sentinel flagged it; the referee paused it.

**Iron rule:** closing a Task never discards its signals, overlays, or changes. It only stops being active.

### 6.2 Task mesh

Tasks form a mesh, not a tree. A Task can branch (spawn children) and fuse (merge with another task, or share a sub-task). Fusion is a first-class operation, mirroring anastomosis in mycelium.

---

## 7. Product Principles (Doctrines)

1. **Never discard computed work.** The substrate may only make work visible, attributable, and reversible. It never silently drops it. Reversibility and recoverability are floor guarantees.
2. **Deterministic floor, intelligent ceiling.** If getting it wrong is irreversible or loses information, it must be deterministic. If getting it wrong is merely suboptimal, delegate it to intelligence.
3. **Bind, do not run.** Hyphae is agent-agnostic. If it needs to know your agent framework, it is not a primitive.
4. **Membership is the trust boundary.** Anyone in the network has full trust. Security is detect, contain, and reverse, not prevent.
5. **Core speaks ops; the filesystem is a pluggable projection.** Real files on disk today, virtual or direct-op agents tomorrow, with no core change.
6. **Continuous anastomosis.** Work fuses continuously. No deferred merge.
7. **Do not rebuild GitHub.** If a shape is one git already has, we probably just copied GitHub.

---

## 8. How It Works (Conceptual)

### 8.1 Two layers, two jobs

```
  DURABLE LAYER  = Cloudflare Artifacts (git)     history, time-travel, forks, interop
  LIVE LAYER     = Durable Object (Referee)       ops, overlays, claims, signals, WebSockets
```

Hyphae stops pretending these are the same thing. The DO is the live coordination core; Artifacts is the durable system of record underneath.

### 8.2 The three-tree mapping

```
  Git today                       Hyphae
  Object store   (history)   ->   Artifacts  (durable git history)
  Index          (staging)   ->   Repo DO    (LIVE, shared index)
  Working tree   (files)     ->   client Materializer (local FS daemon for now)
```

Git's index is per-developer and private. Ours is shared and live. That inversion is the product.

### 8.3 The live op stream

1. On connect, a client receives the **base snapshot** (a git commit via Artifacts).
2. From then on, the Referee streams every **op** and **signal** over a WebSocket in one strict order.
3. The client applies ops to its copy. Because the DO is single-threaded, the order is total and all clients converge to the exact same state.

Exactness comes from deterministic ops plus one canonical order. No CRDT, no eventual convergence guesswork.

### 8.4 Collision and fusion

- Ops are tracked at **line/region granularity** (deterministic floor).
- Two tasks touching *non-overlapping* regions **fuse automatically**.
- Two tasks touching *overlapping* regions raise a **live collision signal** to both, immediately, while context is hot.
- A semantic advisory layer (embeddings/AST, plus a decision model such as Cloudflare Clef) can flag *semantic* collisions the geometric layer misses. This is advisory, never authoritative.

### 8.5 Checkpointing

- The Referee **persists every op the instant it arrives** (DO storage is durable). In-flight work can never be lost, even mid-edit.
- Artifacts receives **automatic, frequent checkpoints** (every N ops, on quiescence, or on demand), giving dense git history, time-travel, forks, and interop.
- **Rule:** the DO never discards an op; Artifacts never needs to be current to be correct.

### 8.6 The Council (future)

A layer of specialized observer agents that read the shared signal stream and act by emitting signals and requests, never by bypassing the Referee.

```
   Reconciler (fuse) · Sentinel (security) · Reviewer (quality) · Allocator (who works on what)
                              │
                    emit signals / requests
                              │
                    Referee (deterministic floor)
```

The Referee is the only thing that mutates truth. Intelligence proposes, the deterministic floor disposes. New capabilities are added by adding observer agents, not by changing the substrate.

---

## 9. Trust and Security Model

- **Membership is the trust boundary.** Being added to the network grants full trust. Removal revokes it.
- No per-file ACLs, no role hierarchy, no approval gates.
- Safety comes from **visibility and reversibility**: nothing is hidden, and everything can be reverted instantly.
- **Agents are first-class actors**, each with its own identity and signature, sponsored by a human who is accountable.
- **Blast-radius circuit breakers** (operational, not an approval gate): for example, a task that touches more than N files pauses and pings a human.
- **Sentinels (future):** observer agents detect malicious or runaway patterns and request containment (pause, quarantine) from the Referee.

---

## 10. Surfaces

| Surface | Priority | Purpose |
|---|---|---|
| **CLI** | MVP, primary | Human-facing: create repos, open tasks, bind agents, watch signals, revert. |
| **MCP server** | MVP, primary | Agent-facing: join a task, read signals, claim scope, propose changes. |
| **HTTP API** | MVP, supporting | Underlying interface; SDK foundation. |
| **Live board (web)** | MVP, spectacle | Watch the swarm: tasks, actors, claims, collisions in real time. Cheap surface built with coding agents. |
| **SDKs** | Post-MVP | Go, Python, TypeScript for platforms. |

The CLI and MCP server are where the real engineering goes. The board is deliberately a thin view over a WebSocket feed.

---

## 11. Key Workflows (User Stories)

1. **Create a repo.** cman creates a Hyphae repo via CLI; it is backed by an Artifacts repo.
2. **Open a task and bind an agent.** cman opens Task "add SSO" and binds his agent via MCP. The agent gets a real working directory.
3. **Live overlay.** As the agent edits, region ops stream to the Repo DO; Saad's agent sees them appear in real time.
4. **Collision.** Saad's agent touches the same region. Both agents get a live collision signal with both sides' context, immediately.
5. **Fusion.** Non-overlapping edits fuse automatically. Overlapping edits are surfaced for reconciliation.
6. **Checkpoint.** The Referee commits the fused state to Artifacts. History, time-travel, and revert all work.
7. **Revert.** A bad change is reverted. Nothing is lost; the reverted work remains recoverable.
8. **Watch.** A human opens the live board and sees tasks, actors, claims, and collisions update in real time.
9. **Close.** A task is settled and closed. Its signals and changes are retained forever.

---

## 12. MVP Definition (IN SCOPE)

**MVP thesis / success criterion:** *cman and Saad each run an agent on the same repo, and neither has to resolve a merge conflict.*

### 12.1 In scope

| Area | MVP scope |
|---|---|
| Repos | Create a repo backed by Artifacts. One repo per team. |
| Tasks | Open, activate, settle, close. Mesh model in the data, branching exposed. |
| Actors | Humans and agents; agent identity sponsored by a human. |
| Participation | MCP server plus CLI to join a task, claim scope, emit changes. |
| Live layer | One Repo DO per repo; durable op log; ordered op stream. |
| Transport | WebSocket streaming with sequence numbers; snapshot plus ops; reconnect/catch-up. |
| Workspaces | Local filesystem daemon (Materializer) that keeps real files on disk in sync with the overlay. |
| Collision | Deterministic line/region overlap detection; live collision signals. |
| Fusion | Automatic fusion of non-overlapping edits; surface overlapping edits. |
| Durability | Automatic, frequent checkpoints to Artifacts; time-travel and revert. |
| Never discard | Every op persisted on arrival; revert restores exactly. |
| Trust | Membership equals full trust; no gates. |
| Board | Minimal live board showing tasks, actors, claims, collisions. |

### 12.2 Explicitly OUT of MVP

| Deferred | Why |
|---|---|
| **The Council** (reconciler, sentinel, reviewer, allocator agents) | Requires a proven substrate first. |
| **Task fusion** (mesh fusion operations) | Modeled in the data, not exposed yet. |
| **Semantic advisory layer** (embeddings/AST, Clef/Jev) | Geometric collisions first; semantic is an enhancement. |
| **Blast-radius circuit breakers** | Nice-to-have safety valve, add after the core loop. |
| **GitHub/GitLab bridge or mirror** | We chose "replace GitHub" for the pure experience; bridge later. |
| **Full web forge** (browsing, history UI, review screens) | CLI plus MCP are the product. |
| **Multi-repo and cross-repo signals** | Single repo first. |
| **Task DOs / sharding** | One Repo DO now; designed-for, not built. |
| **CRDT / offline convergence** | The single referee gives convergence for free. |
| **SDKs, public protocol, auth/SSO depth** | Post-MVP ecosystem work. |
| **Capability-adaptive trust / learning** | Needs a Council and real usage data. |

---

## 13. Phased Roadmap

```
PHASE 0 - WALKING SKELETON   ("two agents stop conflicting")   <- MVP
  Repo create (Artifacts) · Open Task · bind agent via MCP
  Region ops -> Repo DO · WebSocket op stream · local FS daemon
  Basic collision signal · automatic checkpoint · revert works
  1 repo · 1 team · no Council · no fusion ops · no board

PHASE 1 - THE LIVE EXPERIENCE  ("watch the swarm")
  Live board · interest-based subscriptions · reconnect/catch-up
  Semantic advisory triage (Clef-flash) · mesh model in place
  Continuous auto-fusion polish

PHASE 2 - THE COUNCIL  ("the network gets smart")
  Reconciler · Sentinel · Reviewer · Allocator agents
  Task fusion (anastomosis) · capability-adaptive trust · circuit breakers

PHASE 3 - SCALE AND ECOSYSTEM  ("the primitive")
  Task DOs · multi-repo and cross-repo signals · GitHub/GitLab bridge
  SDKs · public protocol · open participant surface
```

---

## 14. Cloudflare Primitive Mapping (Preliminary; ADR to formalize)

| Need | Primitive |
|---|---|
| Durable versioned storage + git interop | **Artifacts** (system of record; R2 for snapshots) |
| Live coordination core (ops, overlays, claims, signals, WebSockets) | **Durable Objects** (one per repo) |
| Stateless edge API, auth, routing, protocol | **Workers** |
| Global queryable metadata (tasks, provenance, audit) | **D1** |
| Large blobs, images, artifacts | **R2** |
| Semantic awareness (embeddings for advisory collisions) | **Vectorize** |
| Signal fan-out, async jobs, notifications, CI hooks | **Queues / Event Subscriptions** |
| Intelligent ceiling (reconciliation, triage, review) | **Workers AI / AI Gateway** (e.g. Cloudflare Clef) |
| Optional hosted execution surface (post-MVP) | **Agents SDK / Containers / Sandboxes** |

---

## 15. Risks and Open Questions

### 15.1 Risks

1. **Artifacts dependency (private beta).** Core to Phase 0. Mitigation to decide: abstract storage behind our own `RepoStore` port with an Artifacts adapter first, so we can swap a backend if needed.
2. **Materializer complexity.** Syncing an arbitrary agent's real files with a live overlay is the main engineering risk. Bounded, not research-grade, because the op stream is exact.
3. **DO limits.** ~128MB memory, single-threaded, SQLite. Mitigation: DO stores ops in SQLite, compacts at checkpoints, holds no file contents. Task DOs are the future scale-out.
4. **Adoption.** "Replace GitHub" is bold. Mitigated by a git escape hatch underneath (Artifacts) and a later bridge.
5. **Trust with no gates.** A runaway agent can touch everything. Mitigated by visibility, reversibility, and (later) circuit breakers and sentinels.

### 15.2 Open questions (to resolve in or before the ADR)

1. **Storage abstraction:** do we define `RepoStore` with an Artifacts adapter plus a fallback from day one?
2. **Op format:** exact schema for region ops (coordinates, base hash, intent, signature).
3. **Materializer design:** local daemon specifics (atomic apply, reconnect, partial reads).
4. **Interest subscriptions:** exact subscription model per path/region.
5. **Semantic tier:** Clef-flash now vs later, and the provider-agnostic interface.
6. **Naming/branding:** confirm "Hyphae" primitives (Task, Signal, Claim, Referee, Council, Materializer).
7. **MVP repo/tooling layout:** monorepo structure, language(s), deploy pipeline.

---

## 16. Success Metrics

- **Primary:** a team runs N agents concurrently on one repo with **zero human-performed merges** over a sprint.
- **Secondary:** time from collision to resolution (lower is better); fraction of overlaps resolved without a human.
- **Guardrail:** zero computed work lost (no op ever dropped, every change recoverable).
- **Adoption:** a second team adopts it without cman in the loop.

---

## 17. Glossary

- **Anastomosis:** the fusion of hyphae to form a network. In Hyphae, the continuous fusion of concurrent work.
- **Claim:** a Signal declaring intended scope.
- **Council:** the future layer of observer agents.
- **Materializer:** the client component that projects the op stream onto real files (or a virtual FS).
- **Op:** a small, deterministic, signed change to a region of a file.
- **Overlay:** a Task's ordered op log on top of a base snapshot.
- **Referee:** the deterministic Durable Object that orders and owns truth.
- **Signal:** the atomic, append-only stigmergic event.
- **Stigmergy:** coordination through signals left in a shared environment, with no central controller.

---

## Appendix A: Decision Log (from the design interview)

| # | Decision |
|---|---|
| Q1 | Hyphae owns coordination + collaboration + surfaces (layers above storage); layering over Artifacts/git remotes, not a storage or protocol rebuild. |
| Q2 | Primary user: teams of engineers (each running 1 to 2+ agents) on shared code. Solve teams, solo follows. |
| Q3 | Core = stigmergic coordination substrate plus delegated reconciliation. Not a smarter merge engine. |
| Q4 | Deterministic floor (atomicity, truthful visibility, isolation, provenance, reversibility, never-discard) vs intelligent ceiling (detection, reconciliation, allocation, review). |
| Q5 | Task-centric and event-sourced: Task is the primary unit of coordination; Signal is the atomic primitive. |
| Q6 | Bind agents, do not run them (MCP/CLI/HTTP; agent-agnostic). |
| Q7 | Continuous hybrid model: live overlay (differentiator) plus git checkpoints (durability). Not a checkpoint/PR-centric model. |
| Q8 | Layered collision semantics: deterministic line/region ops as truth, plus semantic advisories for the intelligent layer. |
| Q9 | One DO referee with a bespoke op log; no CRDT initially; explicit seam for a future referee Council. |
| Q10 | No gate: membership equals full trust. Safety via visibility and reversibility. |
| Q11 | Agents are first-class actors, sponsored by a human, with their own identity and signature. |
| Q12 | Replace GitHub for the MVP (pure experience); bridge later. Git escape hatch preserved via Artifacts. |
| Q13 | CLI plus MCP server are the product; the live web board is a thin, cheap spectacle. |
| Q14 | Task is a **mesh** (branches and fuses), not a tree; event-sourced; lifecycle plus orthogonal flags. |
| Q15 | MVP = two teammates' agents stop conflicting, live. Accept real files on disk via a local Materializer, designed to be replaceable post-MVP. |
| Q16 | DO persists live truth continuously (never loses in-flight work); Artifacts holds durable history with automatic frequent checkpoints. |
| Q17 | One Repo DO per repo now; Task DOs designed-for, not built. |
| Q18 | Phasing: Phase 0 walking skeleton (MVP), Phase 1 live experience, Phase 2 Council, Phase 3 scale and ecosystem. |

## Appendix B: Research Notes

- **Cloudflare Artifacts** (blog, April 2026): git-compatible versioned storage for agents on Durable Objects + R2 + KV; Zig/WASM git server; millions of repos; fork and import; REST + Workers API; private beta. This is the storage foundation we build above.
- **Chroma, "Agent Swarms are a Distributed Systems Problem":** Fission protocol; early-commit, no rollback; git is bad at conflicts; 3/8 agents abandon work rather than merge.
- **System One decision models:** Jev (TypeSafe, hosted, Workers AI binding) and Cloudflare Clef (27B / Clef-flash 9B, open weights, Workers AI native, ~39ms flash latency). Classifiers, not merge engines. Candidates for the semantic advisory / Council triage, behind a provider-agnostic interface.
- **Prior art for conflict-as-data:** Jujutsu, Pijul, mergiraf, difftastic.
