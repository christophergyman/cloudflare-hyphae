# @hyphae/repostore

The storage ports (ADR-007, ADR-018, ADR-020): `RepoStore` for durable git
history and `BlobStore` for content-addressed bytes, plus their adapters.

## Public API

Entry point: `src/index.ts`.

- Ports: `RepoStore`, `BlobStore`, `RepoRef`, `TreeFile`, `CommitAuthor`,
  `StoredCommit`.
- Artifacts adapter: `ArtifactsRepoStore`, `isMissingRefError`,
  `ArtifactsLike`.
- R2 adapter: `R2BlobStore`, `R2BucketLike`.
- In-memory test doubles: `MemoryRepoStore`, `MemoryBlobStore`, `MemoryFS`.

The core depends on the ports only. Artifacts and R2 are adapters behind them.

## Tests

```
bun test packages/repostore
```
