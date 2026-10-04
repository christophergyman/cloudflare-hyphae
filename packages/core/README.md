# @hyphae/core

The plain, runtime-agnostic domain model for Hyphae: the types that every other
package shares, plus small crypto and metrics helpers.

## Public API

Entry point: `src/index.ts`.

- Types: `Repo`, `Manifest`, `ManifestEntry`, `Change`, `Conflict`, `Actor`,
  `RemovedActor`, `RepoId`, `ActorId`, `BlobHash`, and the `Metrics` port.
- Functions: `sha256Hex`, `bytesEqual`, `toHex`.
- Metrics adapters: `analyticsEngineMetrics`, `noopMetrics`.

No Node built-ins and no Cloudflare globals, so it runs in workerd and Bun.

## Tests

```
bun test packages/core
```
