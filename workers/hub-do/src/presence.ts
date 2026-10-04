/**
 * Presence mapping for the Hub (ADR-012).
 *
 * Turns the connected clients' per-connection state into the presence message
 * the live view renders. Pure, so the Agent only gathers connections, builds
 * the message, and broadcasts it.
 */

/** The actor shape the live view consumes. */
export interface PresenceActor {
  actorId: string;
  displayName: string;
  kind: "human" | "agent";
  observer: boolean;
}

/** The per-connection state presence needs (a subset of `ConnectionState`). */
export interface PresenceStateLike {
  actorId: string;
  displayName: string;
  kind: "human" | "agent";
  observer?: boolean;
}

const UNKNOWN_ACTOR: PresenceStateLike = {
  actorId: "unknown",
  displayName: "unknown",
  kind: "human",
};

/** Build the presence broadcast message from the current connection states. */
export function presenceMessage(states: Iterable<PresenceStateLike | null | undefined>): {
  type: "presence";
  actors: PresenceActor[];
} {
  const actors: PresenceActor[] = [];
  for (const state of states) {
    const s = state ?? UNKNOWN_ACTOR;
    actors.push({
      actorId: s.actorId,
      displayName: s.displayName,
      kind: s.kind,
      observer: s.observer ?? false,
    });
  }
  return { type: "presence", actors };
}
