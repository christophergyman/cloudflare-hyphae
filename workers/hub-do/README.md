# @hyphae/hub

The Hub (ADR-017, ADR-019): one Agents SDK `Agent` per repo. It is the live
authority that owns the manifest, decides collisions, merges, and broadcasts.

## Public API

Entry point: `src/index.ts`.

- `Hub`: the Durable Object class, a thin transport shell over `HubCore`. It
  implements `HubRpc` (`checkpoint`, `manifest`, `recentEvents`).
- `HubEnv`: bindings (`BLOBS`, `REPO_STORE`, `ARTIFACTS`, `MERGE`, `AI`,
  `MODEL`, `TEST_COMMAND`, `STORE_REPO`). `STORE_REPO` is the Artifacts repo
  name and defaults to `"main"`; the git ref stays `heads/main`.
- `HubCore` and `ApplyResult`: the framework-agnostic sync authority.
- `CheckpointScheduler` and `runCheckpoint`: when and how live state is
  committed to Artifacts (ADR-006).
- `HistoryFeed`: the bounded recent-activity feed for the live view.

## Tests

```
bun test workers/hub-do
```
