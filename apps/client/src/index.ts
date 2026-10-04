/**
 * @hyphae/client: the local daemon that keeps a working folder in sync.
 *
 * Pieces (all unit-testable):
 *   - detector: debounce, change detection, echo suppression
 *   - paths: path jail + atomic apply
 *   - sync: local <-> Hub change flow with an offline queue
 *   - fs: Node and in-memory filesystem ports
 *   - watcher: the thin fs.watch shell
 */

export type { ChangeKind, DetectedChange, SyncedState } from "./detector.ts";
export { ChangeDetector } from "./detector.ts";
export { MemoryFileSystem, NodeFileSystem } from "./fs.ts";
export type { FileSystemPort } from "./paths.ts";
export { applyRemoteChange, PathJailError, resolveSafePath } from "./paths.ts";
export type { BlobFetcher, BlobPusher, ClientTransport } from "./sync.ts";
export { SyncEngine } from "./sync.ts";
export type { WatcherOptions } from "./watcher.ts";
export { Watcher } from "./watcher.ts";
