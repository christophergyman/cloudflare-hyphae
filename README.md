# Cloudflare Hyphae

A repo whose files stay in sync live across a team, backed by real git history on Cloudflare, with an AI agent that resolves merge conflicts for you.

**In one line:** Dropbox liveness plus git history plus a merging agent, built on Cloudflare.

---

## What this is

Hyphae is a new kind of shared repository for teams where every engineer runs one or more AI coding agents on the same code. Instead of branches, worktrees, and pull requests that collide at merge time, the working files simply stay in sync across the team, continuously, and any real conflict is resolved automatically and verifiably.

If you are an AI agent picking this repo up: read this file, then the documents in `docs/`. They are the source of truth. This README tells you what the project is, the rules that must not be broken, and where everything lives.

---

## The problem

Teams now run many AI agents against shared code. Git's model (branches, PRs, deferred merge) makes that collide, and the cost of integrating the work lands on humans. Agents waste expensive work on conflicts, and nobody can see each other's in-flight changes.

Founding scenario: two engineers each run a couple of agents, and they constantly conflict with each other.

---

## The idea

Three things that already work, combined:

- **Dropbox** keeps files in sync live, with no branches and no PRs.
- **Git** already knows how to merge two versions of a file.
- **A Cloudflare Durable Object** is a live, always-on, single-authority room for one repo.

We do not invent a merge engine. We sync at the **file** level and let **git** merge, continuously. When git cannot merge (same lines changed), a model resolves the conflict **inside an isolated Cloudflare Sandbox and runs the tests before we accept it.**

```
   teammate A (agent/human)              teammate B (agent/human)
        local files                          local files
            │  file save                          │  file change
            ▼                                      ▼
        ┌──────────────────────────────────────────────┐
        │  HUB  (one Durable Object per repo)           │
        │  live versions of every file, who touched what│
        │  merge + broadcast                            │
        └───────────┬──────────────────────────────────┘
                    │  real conflict
                    ▼
        ┌──────────────────────────────────────────────┐
        │  WORKFLOW: model merges -> Sandbox runs tests │
        │  -> commit only if green                      │
        └───────────┬──────────────────────────────────┘
                    │  periodic checkpoints
                    ▼
        ┌──────────────────────────────────────────────┐
        │  Artifacts (git history, clones, time-travel)  │
        └──────────────────────────────────────────────┘
```

---

## The Hub orchestrates; it does not do the heavy lifting

The Hub is the conductor, not the orchestra. It is deliberately thin: it decides and coordinates, and delegates the expensive work. That separation is why it stays fast and why big files never bottleneck it.

```
                        ┌─────────────────────────┐
        clients  ◄─────►│        THE HUB          │◄─────► WebSocket clients
       (control)        │  (one Agent per repo)   │
                        │                         │
                        │  the authority:         │
                        │  who changed what       │
                        │  is this a collision?   │
                        │  broadcast the result   │
                        └────┬───────┬───────┬────┘
                             │       │       │
              content?  ─────┘       │       └───── heavy merge?
                                     │
                              durability?                ┌───────────────┐
                                     │                   │  WORKFLOW +   │
                                     ▼                   │  CONTAINER    │
                              ┌─────────────┐            │  + AI model   │
                              │  ARTIFACTS  │            └───────────────┘
                              │  (git)      │
                              └─────────────┘
                                     ▲
                              ┌─────────────┐
                              │     R2      │  content is fetched by clients
                              │  (blobs)    │  directly, not through the Hub
                              └─────────────┘
```

| The Hub owns (the brain) | It delegates (the muscle) |
|---|---|
| The manifest: current version of every file | File content to **R2** |
| Deciding "clean update or collision?" via `baseHash` | The heavy merge job to a **Workflow plus Container** |
| Running the fast git 3-way merge | Model calls to **AI Gateway** |
| Broadcasting changes to clients | Durable git history to **Artifacts** |
| Presence: who is connected, who touched what | Metrics to **Analytics Engine** |
| Checkpoint scheduling (quiet, ceiling, manual) | Long file transfers to **R2 presigned URLs** |

**The Hub decides; R2, Artifacts, Workflows, and the model do.**

---

## Status

- **Phase:** the full demo path is built and **running live on Cloudflare**.
- **Live deployment:** `https://hyphae-edge.christophergayiuman.workers.dev` serves the API and the **live view** (open it and enter a repo name).
- **Proven live:** two clients sync through the Hub over the Agents SDK WebSocket; a concurrent **disjoint** edit clean-merges with correct content; a concurrent **same-line** edit surfaces a conflict; blobs round-trip through R2; the live view shows actors, files, activity, and previews in real time.
- **Live view (`apps/web`):** a read-only dashboard served as a static asset from the edge Worker. Shows connected actors, current files and versions, a live activity feed (changes, clean merges, conflicts, agent resolutions), and a file preview from R2. The Hub keeps the last 200 events so the feed is populated on open.
- **Spike 1 (Artifacts write path):** proven locally against a real git server (commit, incremental push, clone-back).
- **Not yet wired live:** Artifacts as the Hub's durable store, and the AI merge (AI Gateway + container). Both are built and unit-tested; only the live bindings remain.
- Cloudflare Artifacts is in open beta and available on the Workers Paid plan.

---

## Read these first

In order:

1. **`README.md`** (this file): what the project is and the rules.
2. **`docs/hyphae-prd.md`**: the product. Vision, problem, users, core concepts, what is in the MVP and what is not, risks, success metrics.
3. **`docs/hyphae-adr.md`**: the architecture. 23 numbered decisions, the data model, protocols, repo layout, and the mapping to Cloudflare primitives.
4. **`docs/hyphae-stack.md`**: the concrete tools and services behind the decisions (Agents SDK, Artifacts write path, Containers, AI Gateway, and more).
5. **`docs/hyphae-plan.md`**: the build sequence. Phases, checkpoints, risk order, and the demo and MVP lines.
6. **`docs/hyphae-context.md`**: research, the review findings and their dispositions, accepted risks, and the loose ends not yet folded into the design.
7. **`docs/archive/`**: the previous (rejected) design, kept for history. Do not build from it.

---

## Non-negotiable design rules

These are decided. Do not silently change them. If a change is genuinely needed, update the ADR with a new decision and say why.

1. **Sync whole files, not byte ranges.** The unit of change is a file. Merging is delegated to git. Do not build an operational-transform or real-time keystroke engine.
2. **Never discard computed work.** Unresolved conflicts keep both sides. History is append-only. Nothing is thrown away.
3. **One Durable Object (the Hub) per repo is the live authority.** No CRDTs, no distributed convergence math.
4. **The Hub holds only the manifest.** All file content lives in R2, content-addressed. The Hub never stores file bytes.
5. **Git merge first, then the agent, then keep both.** Deterministic and cheap first, intelligent second, always lossless.
6. **The merging agent must be generative and verified.** It runs in an isolated Cloudflare Container and its result is accepted only if the build and tests pass.
7. **Bind agents, do not run them.** Any harness participates via the CLI and the MCP server. The client watcher captures edits automatically; coordination must not depend on agents calling tools.
8. **Trust is membership based.** Being in the repo means full trust. Identity exists for attribution and revocation, not for gates.
9. **The client watcher ignores its own writes.** Echo suppression and minimal change detection is the core of the client.
10. **Everything runs on Cloudflare primitives, and storage stays behind the `RepoStore` interface.**

---

## Explicitly ruled out

Do not build these. They were considered and rejected:

- **Byte-level (keystroke) live sync.** It required a hand-built real-time merge engine and was the main blocker in review. File-level sync plus git merge replaces it.
- **CRDTs / operational transform.** Not needed once the Hub is the single authority.
- **Using Clef or Jev as the merging agent.** They are decision/classifier models; they cannot write merged code. The merging agent needs a generative code model.
- **Running agents ourselves.** We bind, we do not run.
- **A task mesh / event-sourced task graph.** Dropped in v2 for simplicity.
- **A full GitHub-style forge (issues, PRs, review UI).** Not the product.
- **Inline file content in the Hub.** Content is always in R2.

The rejected v1 design lives at `docs/archive/hyphae-adr-v1-live-ops.md`. It is preserved, not deleted, and not to be revived without a new decision.

---

## Architecture at a glance

| Need | Cloudflare primitive |
|---|---|
| Durable versioned storage, git history, clones | **Artifacts** |
| Live per-repo authority, sync, WebSockets | **Durable Objects** via the **Agents SDK `Agent`** |
| Edge API, auth, routing | **Workers** |
| Blob content, direct transfer | **R2** with presigned URLs |
| Durable merge job (resolve + verify + commit) | **Workflows** |
| Code-capable model calls | **AI Gateway** (frontier model, Workers AI fallback) |
| Isolated space to resolve and run tests | **Containers** (`ctx.container`) |
| Metrics and the moat signal | **Workers Analytics Engine** |
| Metadata, attribution (later) | **D1** |
| Agent participation | **MCP server + CLI** |

Full detail is in `docs/hyphae-adr.md` and `docs/hyphae-stack.md`.

---

## Planned repository layout

This does not exist yet. It is the target for Phase 0.

```
/apps
  /cli            Bun + TS    human CLI and the local daemon (watcher + sync + journal)
  /mcp            TS          MCP server for agents
  /web            TS          simple live view
/workers
  /edge           TS          auth, routing, REST, WebSocket upgrade, blob presign
  /hub-do         TS          the Hub (Agents SDK Agent)
  /merge-workflow TS          Workflow: model merge + container verify + commit
/packages
  /core           TS          domain: Repo, Manifest, Change, Conflict, Actor
  /merge          TS          diff3 merge + merging-agent interface (runtime-agnostic)
  /repostore      TS          RepoStore port + Artifacts adapter
  /protocol       TS          WebSocket and REST schemas (shared, versioned)
/infra
  wrangler.toml, R2 bucket, Container/Dockerfile, Workflow + AI Gateway config
/docs
  hyphae-prd.md, hyphae-adr.md, hyphae-stack.md, hyphae-plan.md, hyphae-context.md, archive/
```

---

## Stack

- **Language:** TypeScript everywhere.
- **Client runtime:** Bun (the CLI plus the local file-watching daemon).
- **Cloudflare runtime:** Workers and Durable Objects (workerd), with the Hub on the **Agents SDK** and the merge verifier on **Containers** (`ctx.container`).
- **Shared code rule:** shared packages use web-standard APIs only, so they run in both workerd and Bun.
- **Requirements:** a Workers Paid plan (about $5/mo). Artifacts, Containers, Workflows, and the good Workers AI code models all need it.
- **Performance escape hatch:** keep the merge/apply logic in `packages/merge` pure and runtime-agnostic, so it could later be compiled to WASM if needed. Do not optimize prematurely.

---

## Key concepts

| Term | Meaning |
|---|---|
| **Repo** | A shared project. One Hub plus one Artifacts git repo. |
| **Hub** | The single Durable Object per repo. The live authority. |
| **Client** | The program on each machine that watches files and syncs them. |
| **Change** | A file save. |
| **Conflict** | The same file changed in two places at once. |
| **Blob** | File content, content-addressed in R2. |
| **Manifest** | The Hub's map of path to current blob version. |
| **Merging agent** | A generative model in an isolated container that resolves conflicts and proves the result with tests. |
| **Actor** | A human or an agent, with identity, for attribution and revocation. |

---

## Roadmap

The full, checkpointed build sequence lives in `docs/hyphae-plan.md`. Short version, in risk order:

1. **Phase 0** Monorepo scaffold, contracts, the `RepoStore` port, and six spikes.
2. **Phase 1** `packages/merge`: the diff3 merge core with property tests.
3. **Phase 2** The Hub (Agents SDK `Agent`) and the live sync loop.
4. **Phase 3** The **client watcher spike** (the riskiest path and the demo's heart).
5. **Phase 4** Checkpoints to Artifacts, plus Hub restart and replay.
6. **Phase 5** The merge Workflow: model call, Container with tests, commit only on green (**demo line**).
7. **Phase 6** CLI, MCP server, and live view (**MVP line**).
8. **Phases 7 to 10** Hardening, demo night, then the moat and scale layers.

Remaining decisions to settle during the build are listed in `docs/hyphae-adr.md`, Part 7.2 and mapped to phases in the plan.

---

## Notes for agents working in this repo

- **The docs are the spec.** If code and docs disagree, the docs win until a new decision is recorded.
- **Keep the two docs in sync with reality.** If you make an architectural choice, add or amend an ADR rather than leaving it implicit.
- **Never lose work, including documentation.** Supersede and archive rather than delete.
- **Prefer the simplest thing that satisfies the rules.** The whole point of v2 over v1 was removing complexity, not adding it.
- **Test the merge and the watcher carefully.** Correctness there is the product.

---

## License

MIT. See `LICENSE`.
