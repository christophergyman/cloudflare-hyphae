import type { HistoryEvent } from "@hyphae/protocol";

export type EventKind = HistoryEvent["kind"];

/**
 * One color per state, everywhere, so the feed, badges, and dots always agree.
 * Conflict is amber (recoverable, the agent engages); red is reserved for errors.
 */
export const SIGNAL_TEXT: Record<EventKind, string> = {
  change: "text-signal-change",
  merge: "text-signal-merge",
  conflict: "text-signal-conflict",
  resolved: "text-signal-resolved",
  delete: "text-signal-delete",
};

export const SIGNAL_DOT: Record<EventKind, string> = {
  change: "bg-signal-change",
  merge: "bg-signal-merge",
  conflict: "bg-signal-conflict",
  resolved: "bg-signal-resolved",
  delete: "bg-signal-delete",
};

export const SIGNAL_BORDER: Record<EventKind, string> = {
  change: "border-l-signal-change",
  merge: "border-l-signal-merge",
  conflict: "border-l-signal-conflict",
  resolved: "border-l-signal-resolved",
  delete: "border-l-signal-delete",
};

export const KIND_LABEL: Record<EventKind, string> = {
  change: "change",
  merge: "merge",
  conflict: "conflict",
  resolved: "resolved",
  delete: "delete",
};
