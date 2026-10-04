# Cloudflare Hyphae - Context and Research Notes

- **Status:** Reference
- **Date:** 2026-10-04
- **Purpose:** Preserve the research, the review findings, and the reasoning behind the design, so nothing important lives only in conversation history.

This document is background. The **source of truth** for the design is `docs/hyphae-prd.md` and `docs/hyphae-adr.md`. This file explains *how we got here* and *what we chose not to do*.

---

## 1. Prior art and landscape

### Cloudflare Artifacts (our storage layer)

- Git-compatible versioned storage built for agents, on Durable Objects + R2 + KV, with a Zig/WASM git server.
- **Moved to open beta on 2026-10-01.** Requires the **Workers Paid** plan (about $5/mo). No waitlist or invite.
- Pricing: first 10,000 operations and 1 GB free, then **$0.15 per 1,000 operations** and **$0.50 per GB-month**. Billing started mid-October 2026.
- Known limits: roughly 1 GB per repo, 32 MB per file, 2,000 git requests per 10 seconds per repo.
- Known issue: `git push` reportedly fails near a 64 MiB pack (open, unassigned).
- Source: Cloudflare blog and docs, April to October 2026.

**Consequence:** the "git on Cloudflare" layer is a commodity. We build above it, behind the `RepoStore` abstraction (ADR-007).

### Chroma, "Agent Swarms are a Distributed Systems Problem"

- Argues that for agents, aborting and retrying throws away expensive reasoning, and that git is bad at conflicts. Measured 3 of 8 agents abandoning work rather than resolving a merge.
- Their fix (Fission) is early commit, per-writer isolation, and no rollback.
- **Influence:** our "never discard computed work" floor and the whole motivation that deferred merge is the enemy.

### Other prior art

- **Jujutsu** (conflict as a first-class object), **Pijul** (patch theory), **mergiraf** and **difftastic** (syntax-aware merge and structural diff). Useful references, not adopted.
- **Oak, Entire, Merget, re_gent**: agent-era version control and merge products. The "git plus AI merge" space is crowded, which is why our differentiator is live sync on Cloudflare plus a **test-verified** merge.

### The Clef and Jev correction

- Cloudflare **Clef** and TypeSafe **Jev** are **decision models** (System One family): you give them a state and typed questions, and they return probabilities and scores.
- They **cannot generate merged code**. They are therefore **not** candidates for the merging agent. The ADR originally named Clef before this was caught.
- The merging agent must be a **generative** code model (ADR-014). Clef or Jev could still be used later as cheap triage (for example "is this a real semantic conflict?"), but never as the resolver.

---

## 2. Cloudflare sandbox research (how the merging agent runs)

The goal: a space where an AI resolves a conflict **and runs the tests** before we accept it. Cloudflare supports this today.

| # | Option | How it works | Cost per merge | Verdict |
|---|---|---|---|---|
| 1 | Model only | A model rewrites the conflicted file, no tests | cents | Rejected: unverified merges |
| 2 | **Workflow + model + test-verifying Sandbox** | Model merges, sandbox runs build/tests, commit only on green | cents | **Chosen (ADR-014)** |
| 3 | Agent loop in a sandbox | Edit, test, read failures, re-edit until green | ~$0.10 to $1 | Good later upgrade (preview APIs) |
| 4 | Full coding-agent CLI in a sandbox | A whole agent (for example Claude Code) resolves autonomously | ~$0.20 to $2 | Powerful, expensive, least deterministic |
| 5 | Dynamic Workers fast path | Millisecond JS/TS merge for trivial conflicts, no npm | near zero | Useful complement later |

**Products used:** Workflows (durable job, retries), Workers AI or an external model via **AI Gateway**, **Sandboxes / Containers** (isolated Linux microVM, GA April 2026), R2, Artifacts.

**Gotchas to remember when building:**

- `npm install` needs the package registry allowed through an egress handler, or dependencies pre-baked into the image.
- Keep the model key in the Worker; the sandbox never sees it (egress injects it).
- One sandbox per merge; never share a sandbox across tasks.
- A running process does not keep the container alive; use a Workflow step or a Durable Object alarm.
- Prompt injection: repo files and test output can try to steer the model. Cap output, and gate commits on green tests plus optional human approval.
- Container scheduling policy and snapshots are public beta.

---

## 3. The v1 to v2 pivot (why the design changed)

v1 synced at the **byte** level: small "region ops" streamed to a Durable Object, a custom operational-transform engine, byte-range collision detection, and a local file interceptor that inferred ops from whole-file writes.

We ran **five independent adversarial reviews** (red team, distributed systems, product, security, Cloudflare/cost). All five converged on the same conclusion: the **op transform / sync engine** was the top blocker, and the MVP as scoped hid enormous work.

**The pivot:** sync whole **files**, and delegate merging to **git**, escalating only true conflicts to a verified sandbox job. This deleted the hardest and most error-prone component while keeping the value (live sync, no cold merges, nothing lost). v1 is archived at `docs/archive/`.

---

## 4. Review findings and their dispositions

Grouped from the 16 findings across the five reviews. "Resolved by v2" means the file-level redesign dissolved the issue.

| Finding | Disposition |
|---|---|
| No op transform; byte offsets do not converge | **Resolved by v2** (file-level, git merge) |
| Ops broadcast before persisted; no retry/duplicate handling | **Rule kept:** save/persist before broadcast; dedupe by change id |
| "All clients converge" vs interest-filtered subscriptions | **Obsolete in v2** (file-granularity updates) |
| MVP win condition contradicted surfaced overlaps | **Resolved:** win restated; demo defined in the PRD |
| "Never discard" vs compaction; rebuild path undefined | **Partly open:** Hub restart/replay is ADR Part 7.2 #4 |
| DO must not hold file bytes or assembled trees | **Resolved:** ADR-004 (manifest only, content in R2) |
| Auto-sync writes foreign content into real files (injection) | **Loose end:** path-jail and secret scan not yet in v2 (see section 5) |
| Identity and signing unresolved | **Resolved:** ADR-009 |
| Git side door bypasses the authority | **Loose end:** keep members read-only on the git remote (see section 5) |
| Abuse resistance (rate limits, CI isolation, board XSS) | **Deliberately deferred** (see section 5) |
| "Replace GitHub" makes the thesis expensive to test | **Accepted:** MVP is self-contained; pilot on one repo (see PRD) |
| Coordination is voluntary; agents may not claim scope | **Resolved by design:** the watcher captures edits; we do not rely on agent cooperation |
| Whole-file writes vs small ops; echo suppression | **Resolved/simplified** in v2 (file watcher, ADR-010) |
| Revert semantics undefined | **Loose end:** not specified in v2 (see section 5) |
| Geometric fusion can ship broken code | **Resolved:** sandbox test verification (ADR-014) |
| D1 as a second source of truth | **Deferred:** Hub holds the manifest; D1 is not in the MVP path |

---

## 5. Accepted risks and loose ends

These are consciously deferred or not yet folded into v2. They are recorded so they are not forgotten.

### Deliberately deferred (accepted risk)

- **Abuse resistance.** We chose not to add, for the MVP: per-actor rate limits and auto-pausing a runaway agent; isolating CI from untrusted code; and XSS-safe rendering on the live view. Accepted risk. The runaway-agent rate limit is the first to revisit, because a stuck agent could spoil the live demo.

### Loose ends to fold into v2 when we build

1. **Path-jail the client.** The client should only write inside the project folder, rejecting `..`, absolute paths, symlink escapes, and dangerous files (for example `.git/hooks`, shell startup files). The v2 design still auto-syncs files, so this injection path exists.
2. **Secret scanning and a redaction exception.** "Never discard" makes a leaked secret permanent. Add scanning at intake and a narrow way to redact a secret value while keeping a tombstone record.
3. **Keep the git remote read-only for members.** Only the Hub writes to the backing Artifacts repo, so no one can change shared state behind the authority. Members keep read and clone.
4. **Revert semantics.** Define how undo works (an inverse change, or keeping both). Undefined in v2.
5. **Hub restart and replay.** The tested procedure to rebuild the Hub from the last commit plus its persisted state (ADR Part 7.2 #4).

---

## 6. Opportunity: Cloudflare's "next Git platform" competition

On 2026-10-01 Cloudflare announced a competition to build the next Git platform on Cloudflare (first prize $25k in credits, finalists at Cloudflare Connect in late October, submissions closing October 14). Their own analysis confirms they ship **no** merge/PR/review primitives and are crowdsourcing that layer, which both validates our positioning and is a possible free launchpad if Phase 0 lands in time. Not a commitment.

---

## 7. How this design was reached (process)

1. Research: Artifacts, Chroma Fission, prior art, decision models.
2. A long design interview that produced v1 (byte-level live ops) and the original PRD/ADR.
3. Five independent adversarial reviews of v1.
4. The reviews converged on the op-transform engine as the blocker.
5. A deliberate simplification to v2 (file-level sync plus git merge plus a verified merge agent).
6. A nine-question resolution round, folded into the ADR.

The rejected v1 lives at `docs/archive/`. It is preserved, not deleted, and not to be revived without a new decision.
