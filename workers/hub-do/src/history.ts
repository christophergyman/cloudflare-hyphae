/**
 * The recent-activity feed (ADR-006, live view).
 *
 * A bounded, newest-last list of events that the Hub replays to a client on
 * connect and persists to Durable Object storage. Kept in its own module so the
 * Hub's `index.ts` stays a thin transport shell, and so the bounded-list logic
 * is unit-testable without a Durable Object.
 */

import type { HistoryEvent } from "@hyphae/protocol";

/** The storage key the feed is persisted under. */
export const HISTORY_KEY = "history";

/** How many recent events to keep for the live view. */
export const HISTORY_LIMIT = 200;

/** Minimal storage surface the feed needs (matches `ctx.storage`). */
export interface HistoryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: HistoryEvent[]): Promise<void>;
}

export class HistoryFeed {
  private events: HistoryEvent[] = [];

  constructor(private readonly storage: HistoryStorage) {}

  /** Load persisted events. Call once during construction/activation. */
  async load(): Promise<void> {
    const stored = await this.storage.get<HistoryEvent[]>(HISTORY_KEY);
    if (stored) this.events = stored;
  }

  /** Append an event and persist the bounded list. */
  async record(event: HistoryEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > HISTORY_LIMIT) {
      this.events = this.events.slice(-HISTORY_LIMIT);
    }
    await this.storage.put(HISTORY_KEY, this.events);
  }

  /** A snapshot of the current events, oldest first. */
  snapshot(): HistoryEvent[] {
    return this.events;
  }

  get size(): number {
    return this.events.length;
  }
}
