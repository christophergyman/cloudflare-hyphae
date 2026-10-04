# Cloudflare Hyphae - Product Requirements Document

- **Status:** Draft v2 (live file sync)
- **Date:** 2026-10-04
- **Author:** Christopher Man (cman), with opencode
- **Companion:** `docs/hyphae-adr.md`
- **Supersedes:** `docs/archive/hyphae-prd-v1-live-ops.md` (byte-level live-ops design)

---

## 1. Vision

Hyphae is a repo whose files stay in sync live across a team, backed by real git history on Cloudflare, with an AI agent that resolves the merge conflicts for you.

**One line:** Dropbox liveness plus git history plus a merging agent, built on Cloudflare.

---

## 2. The Problem

Teams of engineers now each run one or more AI agents on shared code. Git's model (branches, PRs, deferred merge) makes concurrent work collide, and the cost of integrating it lands on humans. Agents waste expensive work on conflicts, and nobody can see each other's in-flight changes.

Founding case: cman and Saad each run agents on the same repo and constantly conflict.

---

## 3. The Insight

Three things that already work, combined:

- **Dropbox** keeps files in sync live, with no branches and no PRs.
- **Git** already knows how to merge two versions of a file.
- **A Cloudflare Durable Object** is a live, always-on, single-authority room for one repo.

We do not need to invent a merge engine. We sync at the **file** level and let **git** merge, continuously and automatically, instead of at PR time. An AI agent handles the rare hard conflicts.

> The version we rejected synced at the byte level and forced us to build our own real-time merge engine. That is what made it complicated. File-level sync plus git merge is dramatically simpler and still solves the real pain.

---

## 4. How It Works

```
   teammate A (agent/human)                teammate B (agent/human)
        local files                            local files
            │  file save                            │  file change
            ▼                                       ▼
        ┌───────────────────────────────────────────────┐
        │   HUB  (one Durable Object per repo)           │
        │   live state: current version of every file    │
        │   who is touching what                          │
        │   merge + broadcast                             │
        └───────────────┬────────────────────────────────┘
                        │  periodic commits
                        ▼
        ┌───────────────────────────────────────────────┐
        │   Artifacts  (git history, time-travel, clones) │
        └───────────────────────────────────────────────┘
```

1. A **repo** is one Durable Object (the Hub) plus an Artifacts git repo.
2. Each teammate runs a small **client** that watches their working folder.
3. When a file is saved, the client sends it to the Hub.
4. Hub checks: has anyone else changed this file since your copy?
   - **No:** accept it, broadcast it, everyone updates. No merge, no human.
   - **Yes:** run **git's normal 3-way merge** (base, yours, theirs).
     - Disjoint edits: it fuses automatically. No human.
     - Same lines: the **merging agent** resolves it. If unsure, keep both and surface it. Never lose work.
5. The Hub periodically commits the merged state to **Artifacts**, giving real git history, time-travel, and `git clone`.

---

## 5. Who It Is For

- **Primary:** engineering teams (roughly 2 to 10) where each engineer runs AI agents on shared code.
- **Also:** any developer who wants a repo that stays in sync without branches and PRs.
- Agents are participants, not tools we run. Hyphae is agent-agnostic (CLI plus MCP).

---

## 6. Core Concepts

| Concept | Meaning |
|---|---|
| **Repo** | A shared project. One Durable Object (Hub) plus one Artifacts git repo. |
| **Hub** | The live authority for a repo. Holds current file versions and who is touching what. |
| **Client** | The small program on each machine that watches files and syncs them. |
| **Change** | A file save. |
| **Conflict** | The same file changed in two places. Resolved by git merge or the merging agent. |
| **Merging agent** | Resolves conflicts git cannot. Never discards work. |
| **Actor** | A human or an agent, with identity, for attribution. |

---

## 7. MVP (In Scope)

- Create a repo, backed by Artifacts.
- Live file sync across 2 or more machines via the Hub (watcher plus WebSocket).
- No-conflict saves land instantly and sync to everyone.
- Same-file, disjoint edits merge automatically using git.
- Real conflicts go to the **merging agent**; if unsure, keep both sides and surface (never lose work).
- Automatic, frequent git commits to Artifacts.
- CLI (humans) plus MCP server (agents).
- A simple live view showing connected teammates and files changing in real time.

**Acceptance demo:** two teammates' agents edit the **same file's different sections at the same time**; the file stays in sync live on both machines; zero human merges. When they touch the same lines, the agent resolves it.

---

## 8. Out of MVP

| Deferred | Why |
|---|---|
| Byte-level (keystroke) sync | File-level plus git merge is enough and far simpler. |
| Tasks / task mesh | Adds concept overhead; not needed for the core loop. |
| Council (reviewer, security, allocator agents) | Only the merging agent is needed to start. |
| Multi-repo and cross-repo awareness | One repo first. |
| GitHub / GitLab bridge | The MVP is self-contained; bridge later. |
| Full web forge (issues, PRs, review UI) | CLI plus MCP plus a simple live view first. |
| Deep auth / SSO | Simple identity is enough to start. |
| Byte-range collision detection, op transform, echo suppression | Removed entirely by moving to file-level sync. |

---

## 9. Architecture Direction (Detail in the ADR)

| Need | Cloudflare primitive |
|---|---|
| Durable versioned storage, git history, clones | **Artifacts** |
| Live per-repo authority, sync, WebSockets | **Durable Objects** |
| Edge API, auth, routing | **Workers** |
| Large blobs, snapshots | **R2** |
| Metadata, attribution (later) | **D1** |
| Merging agent | **Workers AI / AI Gateway** |
| Agent participation | **MCP server + CLI** |

---

## 10. Risks

1. **Client watcher reliability.** Keeping the local folder and the Hub in sync, and ignoring its own writes (no echo), is the main engineering risk.
2. **Merge quality.** Git handles disjoint edits well; overlapping edits need the agent, and the agent must never lose work (when unsure, keep both).
3. **Artifacts is open beta.** Mitigate by abstracting storage behind our own interface.
4. **Differentiation.** "Git plus AI merge" is a crowded space; our edge is live sync on Cloudflare and the merging agent, and we should prove it with the demo.

---

## 11. Success Metrics

- **Primary:** a team edits the same repo concurrently with **zero human-performed merges** over a sprint, with files staying in sync live.
- **Secondary:** time from file save to visible on teammates' machines (target: under one second).
- **Guardrail:** zero work lost. Any unresolved conflict keeps both sides.

---

## 12. What Changed From v1

v1 synced at the byte level and required a custom real-time merge engine (op transform, echo suppression, collision ranges). Five independent reviews flagged that engine as the main blocker. v2 syncs at the file level and **delegates merging to git**, keeping the liveness and the agent-assisted conflict resolution while deleting the hardest parts. v1 is preserved at `docs/archive/hyphae-prd-v1-live-ops.md`.
