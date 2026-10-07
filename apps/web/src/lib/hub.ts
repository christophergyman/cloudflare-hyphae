/**
 * The console's connection to one Hub (ADR-013).
 *
 * It speaks the same WebSocket protocol as the CLI clients. By default it is a
 * full editor connection (one per tab) with a name you control, so two tabs,
 * or a tab and a CLI daemon, behave like two teammates. `?view=1` makes the
 * connection a read-only observer.
 *
 * Responsibilities:
 *   - identity: an actor name persisted locally, editable, also settable via
 *     `?actor=`
 *   - entry: `?repo=` deep links, last repo remembered, auto-connect on load
 *   - resilience: auto-reconnect with backoff, last-event time for staleness
 *   - composer support: blob upload, raw/stale-base changes, deletions,
 *     manifest polling
 *   - context for the UI: presence, manifest, feed, previous hashes (for
 *     diffs), and live conflict states
 */

import type { ChangeMessage, HistoryEvent, HubMessage, ManifestEntry } from "@hyphae/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface Actor {
  actorId: string;
  displayName: string;
  kind: "human" | "agent";
  /** The Hub sends this; observers are viewers, not editors. */
  observer?: boolean;
}

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface FeedEvent extends HistoryEvent {
  /** Stable id, so React keys never depend on array index. */
  id: number;
}

export interface ConflictState {
  path: string;
  status: "open" | "resolved" | "kept-both";
  detail?: string;
  at: number;
}

export interface HubApi {
  status: ConnectionStatus;
  repo: string;
  /** This tab's actor name (also its actor id). */
  actor: string;
  /** Read-only connection (`?view=1`): no composer. */
  viewOnly: boolean;
  manifest: Map<string, ManifestEntry>;
  actors: Actor[];
  events: FeedEvent[];
  conflicts: ConflictState[];
  /** Timestamp of the last message from the Hub, for staleness. */
  lastEventAt: number | null;
  /** Reconnect attempts since the last successful open. */
  attempts: number;
  connect(repo: string): void;
  disconnect(): void;
  retry(): void;
  /** Rename this connection and reconnect if needed. */
  setActor(name: string): void;
  /** Upload content and send a normal change (base from the manifest). */
  sendChange(path: string, content: string): Promise<void>;
  /** Send a tombstone for the path (delete). */
  sendDeletion(path: string): Promise<void>;
  /** Send a change with an explicit base, for scenario traffic. */
  sendRawChange(path: string, baseHash: string | null, newHash: string | null): void;
  /** Upload a blob and return its content hash. */
  uploadBlob(content: string): Promise<string>;
  /** Resolve once the manifest shows `hash` for `path` (or timeout). */
  waitForManifest(path: string, hash: string, timeoutMs?: number): Promise<boolean>;
  getEntry(path: string): ManifestEntry | undefined;
  /** The version seen before the current one, while this tab was open. */
  previousHash(path: string): string | undefined;
  checkpoint(): Promise<boolean>;
  dismissConflict(path: string): void;
}

const FEED_LIMIT = 200;
const REPO_KEY = "hyphae.repo";
const ACTOR_KEY = "hyphae.actor";
const RECONNECT_MAX_MS = 15_000;
const CONFLICT_WINDOW_MS = 15 * 60 * 1000;

function randomActor(): string {
  return `console-${crypto.randomUUID().slice(0, 4)}`;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: persistence is best-effort.
  }
}

function initialActor(): string {
  const stored = readStored(ACTOR_KEY);
  if (stored) return stored;
  const generated = randomActor();
  persist(ACTOR_KEY, generated);
  return generated;
}

export function useHub(): HubApi {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [repo, setRepo] = useState("");
  const [actor, setActorState] = useState(initialActor);
  const [viewOnly, setViewOnly] = useState(false);
  const [manifest, setManifest] = useState<Map<string, ManifestEntry>>(new Map());
  const [actors, setActors] = useState<Actor[]>([]);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [conflicts, setConflicts] = useState<ConflictState[]>([]);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [attempts, setAttempts] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const repoRef = useRef(repo);
  const actorRef = useRef(actor);
  const viewOnlyRef = useRef(viewOnly);
  const manualCloseRef = useRef(false);
  const unmountedRef = useRef(false);
  const attemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manifestRef = useRef(manifest);
  const previousHashRef = useRef<Map<string, string>>(new Map());
  const conflictsRef = useRef<Map<string, ConflictState>>(new Map());
  const feedIdRef = useRef(0);

  useEffect(() => {
    manifestRef.current = manifest;
  }, [manifest]);
  useEffect(() => {
    repoRef.current = repo;
  }, [repo]);
  useEffect(() => {
    actorRef.current = actor;
  }, [actor]);
  useEffect(() => {
    viewOnlyRef.current = viewOnly;
  }, [viewOnly]);

  const pushEvent = useCallback((event: HistoryEvent) => {
    feedIdRef.current += 1;
    const stamped: FeedEvent = { ...event, id: feedIdRef.current };
    setEvents((prev) => {
      const next = [...prev, stamped];
      return next.length > FEED_LIMIT ? next.slice(next.length - FEED_LIMIT) : next;
    });
  }, []);

  const upsertConflict = useCallback((state: ConflictState) => {
    conflictsRef.current.set(state.path, state);
    setConflicts([...conflictsRef.current.values()].sort((a, b) => b.at - a.at));
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connectInternal = useCallback(
    (name: string) => {
      const existing = socketRef.current;
      if (existing) {
        existing.onclose = null;
        existing.close();
        socketRef.current = null;
      }
      clearReconnectTimer();
      manualCloseRef.current = false;

      setRepo(name);
      repoRef.current = name;
      setStatus("connecting");
      setManifest(new Map());
      setActors([]);
      setEvents([]);
      conflictsRef.current = new Map();
      setConflicts([]);
      previousHashRef.current = new Map();

      const actorId = actorRef.current;
      const observer = viewOnlyRef.current;
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const params = new URLSearchParams({
        actorId,
        displayName: actorId,
        kind: "human",
      });
      if (observer) params.set("observer", "1");
      const url = `${scheme}://${location.host}/agents/hub/${encodeURIComponent(name)}?${params.toString()}`;

      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        attemptsRef.current = 0;
        setAttempts(0);
        setStatus("open");
        socket.send(JSON.stringify({ type: "hello", actorId, repoId: name }));
      };

      const scheduleReconnect = () => {
        if (unmountedRef.current || manualCloseRef.current) return;
        attemptsRef.current += 1;
        setAttempts(attemptsRef.current);
        setStatus("reconnecting");
        const delay = Math.min(1000 * 2 ** (attemptsRef.current - 1), RECONNECT_MAX_MS);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (!unmountedRef.current && !manualCloseRef.current && repoRef.current) {
            connectInternal(repoRef.current);
          }
        }, delay);
      };

      socket.onclose = () => {
        if (socketRef.current === socket) setStatus("closed");
        scheduleReconnect();
      };

      socket.onerror = () => {
        // onclose follows and owns the retry; keep the UI quiet here.
      };

      socket.onmessage = (event) => {
        setLastEventAt(Date.now());
        let message: HubMessage;
        try {
          message = JSON.parse(String(event.data)) as HubMessage;
        } catch {
          return;
        }
        switch (message.type) {
          case "manifest": {
            const next = new Map<string, ManifestEntry>();
            for (const [path, entry] of Object.entries(message.entries)) {
              next.set(path, entry);
            }
            setManifest(next);
            break;
          }
          case "presence": {
            // Dedupe by actor id: a reconnect can race the old socket's close,
            // and two tabs may share a name. One actor, one chip.
            const byId = new Map<string, Actor>();
            for (const actor of message.actors) {
              if (!byId.has(actor.actorId)) byId.set(actor.actorId, actor);
            }
            setActors([...byId.values()]);
            break;
          }
          case "history": {
            setEvents(
              message.events.slice(-FEED_LIMIT).map((event) => {
                feedIdRef.current += 1;
                return { ...event, id: feedIdRef.current };
              }),
            );
            // Seed the conflict strip from recent history so a reload keeps
            // the story. Kept-both outcomes are recorded by the agent.
            const now = Date.now();
            for (const event of message.events) {
              if (event.at < now - CONFLICT_WINDOW_MS || !event.path) continue;
              if (event.kind === "conflict") {
                const byAgent = event.by === "merging-agent";
                const keptBoth =
                  byAgent &&
                  (event.detail?.startsWith("kept both") ||
                    event.detail?.startsWith("merge failed"));
                upsertConflict({
                  path: event.path,
                  status: keptBoth ? "kept-both" : "open",
                  detail: event.detail,
                  at: event.at,
                });
              } else if (event.kind === "resolved") {
                upsertConflict({
                  path: event.path,
                  status: "resolved",
                  detail: event.detail,
                  at: event.at,
                });
              }
            }
            break;
          }
          case "changed": {
            const { path, newHash, version, by } = message;
            const previous = manifestRef.current.get(path)?.blobHash;
            if (newHash !== null && previous && previous !== newHash) {
              previousHashRef.current.set(path, previous);
            }
            setManifest((prev) => {
              const next = new Map(prev);
              if (newHash === null) {
                next.delete(path);
              } else {
                next.set(path, {
                  blobHash: newHash,
                  version,
                  updatedBy: by,
                  updatedAt: Date.now(),
                });
              }
              return next;
            });
            pushEvent({
              kind: newHash === null ? "delete" : "change",
              path,
              by,
              version,
              at: Date.now(),
            });
            break;
          }
          case "conflict": {
            const { path, keptBoth } = message;
            if (keptBoth) {
              upsertConflict({
                path,
                status: "kept-both",
                detail: "both sides kept",
                at: Date.now(),
              });
              pushEvent({
                kind: "conflict",
                path,
                by: "merging-agent",
                detail: "kept both, nothing lost",
                at: Date.now(),
              });
            } else {
              upsertConflict({ path, status: "open", at: Date.now() });
              pushEvent({ kind: "conflict", path, at: Date.now() });
              toast.warning(`Conflict on ${path}`);
            }
            break;
          }
          case "resolved": {
            const { path, newHash } = message;
            const previous = manifestRef.current.get(path)?.blobHash;
            if (newHash !== null && previous && previous !== newHash) {
              previousHashRef.current.set(path, previous);
            }
            if (newHash !== null) {
              setManifest((prev) => {
                const entry = prev.get(path);
                if (!entry) return prev;
                const next = new Map(prev);
                next.set(path, { ...entry, blobHash: newHash, updatedAt: Date.now() });
                return next;
              });
            }
            upsertConflict({
              path,
              status: "resolved",
              detail: "resolved by agent",
              at: Date.now(),
            });
            pushEvent({ kind: "resolved", path, at: Date.now() });
            toast.info(`Agent resolved ${path}`);
            break;
          }
          case "error":
            toast.error(`${message.code}: ${message.message}`);
            break;
        }
      };
    },
    [clearReconnectTimer, pushEvent, upsertConflict],
  );

  const connect = useCallback(
    (rawRepo: string) => {
      const name = rawRepo.trim();
      if (!name) return;
      persist(REPO_KEY, name);
      // Keep the address bar deep-linkable, so a copy pastes a live repo.
      try {
        const params = new URLSearchParams({ repo: name, actor: actorRef.current });
        if (viewOnlyRef.current) params.set("view", "1");
        history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
      } catch {
        // History and URL are best-effort niceties.
      }
      connectInternal(name);
    },
    [connectInternal],
  );

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    clearReconnectTimer();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    setStatus("idle");
  }, [clearReconnectTimer]);

  const retry = useCallback(() => {
    if (repoRef.current) connectInternal(repoRef.current);
  }, [connectInternal]);

  const setActor = useCallback(
    (rawName: string) => {
      const name = rawName.trim().slice(0, 128);
      if (!name || name === actorRef.current) return;
      actorRef.current = name;
      persist(ACTOR_KEY, name);
      setActorState(name);
      if (repoRef.current && !manualCloseRef.current) connectInternal(repoRef.current);
    },
    [connectInternal],
  );

  const sendChange = useCallback(async (path: string, content: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("not connected to a hub");
    const upload = await fetch("/blobs", { method: "PUT", body: content });
    if (!upload.ok) {
      const detail = await upload.text().catch(() => "");
      throw new Error(`blob upload failed: ${upload.status} ${detail}`);
    }
    const { hash } = (await upload.json()) as { hash: string };
    const baseHash = manifestRef.current.get(path)?.blobHash ?? null;
    const change: ChangeMessage = {
      type: "change",
      id: crypto.randomUUID(),
      path,
      baseHash,
      newHash: hash,
    };
    socket.send(JSON.stringify(change));
  }, []);

  const uploadBlob = useCallback(async (content: string): Promise<string> => {
    const upload = await fetch("/blobs", { method: "PUT", body: content });
    if (!upload.ok) throw new Error(`blob upload failed: ${upload.status}`);
    const { hash } = (await upload.json()) as { hash: string };
    return hash;
  }, []);

  const sendRawChange = useCallback(
    (path: string, baseHash: string | null, newHash: string | null) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN)
        throw new Error("not connected to a hub");
      socket.send(
        JSON.stringify({ type: "change", id: crypto.randomUUID(), path, baseHash, newHash }),
      );
    },
    [],
  );

  const sendDeletion = useCallback(async (path: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("not connected to a hub");
    const baseHash = manifestRef.current.get(path)?.blobHash ?? null;
    socket.send(
      JSON.stringify({ type: "change", id: crypto.randomUUID(), path, baseHash, newHash: null }),
    );
  }, []);

  const waitForManifest = useCallback(
    (path: string, hash: string, timeoutMs = 5000): Promise<boolean> =>
      new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          if (manifestRef.current.get(path)?.blobHash === hash) return resolve(true);
          if (Date.now() - started > timeoutMs) return resolve(false);
          setTimeout(tick, 150);
        };
        tick();
      }),
    [],
  );

  const getEntry = useCallback((path: string) => manifestRef.current.get(path), []);

  const previousHash = useCallback((path: string) => previousHashRef.current.get(path), []);

  const checkpoint = useCallback(async () => {
    const res = await fetch(`/repos/${encodeURIComponent(repoRef.current)}/commit`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`checkpoint failed: ${res.status}`);
    const body = (await res.json()) as { committed?: boolean };
    return body.committed === true;
  }, []);

  const dismissConflict = useCallback((path: string) => {
    conflictsRef.current.delete(path);
    setConflicts([...conflictsRef.current.values()].sort((a, b) => b.at - a.at));
  }, []);

  // Entry: prefer the URL, fall back to the last repo this browser used.
  useEffect(() => {
    // StrictMode mounts, cleans up, and mounts again in dev. Reset the flag
    // here so the second mount (and every retry after it) can reconnect.
    unmountedRef.current = false;
    const params = new URLSearchParams(location.search);
    const urlActor = params.get("actor");
    if (urlActor) {
      actorRef.current = urlActor.slice(0, 128);
      persist(ACTOR_KEY, actorRef.current);
      setActorState(actorRef.current);
    }
    const view = params.get("view") === "1";
    viewOnlyRef.current = view;
    setViewOnly(view);

    const target = params.get("repo") ?? readStored(REPO_KEY);
    if (target) connectInternal(target);
    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [connectInternal]);

  return {
    status,
    repo,
    actor,
    viewOnly,
    manifest,
    actors,
    events,
    conflicts,
    lastEventAt,
    attempts,
    connect,
    disconnect,
    retry,
    setActor,
    sendChange,
    sendDeletion,
    sendRawChange,
    uploadBlob,
    waitForManifest,
    getEntry,
    previousHash,
    checkpoint,
    dismissConflict,
  };
}

/** Fetch one blob by hash. Returns null text for binary content. */
export async function fetchBlob(hash: string): Promise<{ text: string | null; bytes: number }> {
  const res = await fetch(`/blobs/${hash}`);
  if (!res.ok) throw new Error(`blob fetch failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const binary = bytes.some((b) => b === 0);
  return { text: binary ? null : new TextDecoder().decode(bytes), bytes: bytes.byteLength };
}
