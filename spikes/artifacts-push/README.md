# Spike 1: push to Artifacts from a Worker

**Question:** can a Worker create an Artifacts repo and push a commit to it with
`isomorphic-git`? This decides whether ADR-018 (the Artifacts write adapter) holds
or falls back to a container running real git.

## Status: mechanics proven locally, Cloudflare leg pending credentials

### Proven here (runnable now)

`bun run local` stands up a real smart-HTTP git server in-process and proves the
exact isomorphic-git code path the Worker uses:

- `git.init` -> write files -> `git.add` -> `git.commit`
- `git.push` over **smart HTTP** with `isomorphic-git/http/web` (the official
  Worker http client)
- an **incremental** second commit, like a checkpoint (ADR-006)
- clone-back and log inspection, confirming the objects landed

Result: isomorphic-git commits and pushes over smart HTTP correctly in Bun.

```
first commit:  a7c0c13...
second commit: def55a4...
cloned log:
  def55a4 incremental checkpoint
  a7c0c13 initial commit
cloned files: README.md, src.txt
```

### Not yet proven (needs a Workers Paid account with Artifacts)

The Cloudflare-specific delta: the Artifacts remote host and token auth. The
Worker in `src/worker.ts` implements it.

```
cd spikes/artifacts-push
bunx wrangler dev
curl -X POST http://localhost:8787/push
```

Expected: JSON with `ok: true`, a `commit` hash, and `refs`. Then:

```
git clone <remote>            # from the response
git log --oneline
```

## Why this matters

The Artifacts Workers binding **cannot read or write files inside a repo**. It
only creates, forks, inspects, and mints tokens. Commits must go through the git
protocol (ADR-018). This spike proves the documented path works.

## Fallback if the Cloudflare leg fails

Switch `RepoStore` to the container-git adapter: run real `git` inside a
Container (`ctx.container`) and push from there. The port in
`packages/repostore` stays the same, so nothing else changes.

## Files

| File | Purpose |
|---|---|
| `scripts/local-push.ts` | Runnable harness, smart-HTTP push, no credentials |
| `src/worker.ts` | The Artifacts Worker (needs an Artifacts binding) |
| `src/memory-fs.ts` | In-memory FS vendored from Cloudflare's example |
| `wrangler.toml` | Worker config with the `artifacts` binding |
