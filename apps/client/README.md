# @hyphae/client

The local daemon that keeps a working folder in sync with a Hub: it watches
files, captures edits, and pushes and applies changes over the protocol.

## Public API

Entry point: `src/index.ts`.

- `Watcher`: the thin `fs.watch` shell that ties the pieces together.
- `SyncEngine`: the local to Hub change flow, with an offline queue.
- `ChangeDetector`: debounce, change detection, and echo suppression.
- `NodeFileSystem` and `MemoryFileSystem`, plus the `FileSystemPort`.
- `resolveSafePath`, `applyRemoteChange`, `PathJailError`: the path jail and
  atomic apply.

The pieces are injected and unit-testable, so the risky sync logic is tested
without a real Hub or filesystem.

## Tests

```
bun test apps/client
```
