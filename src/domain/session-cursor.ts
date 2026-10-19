import type { SessionEvent, SessionIdentity } from "../contracts/session";

export interface SessionCursor extends SessionIdentity {
  readonly sequence: number;
}

export type CursorDecision =
  | { readonly accepted: true; readonly cursor: SessionCursor }
  | {
      readonly accepted: false;
      readonly reason: "wrong-network" | "wrong-generation" | "duplicate" | "sequence-gap";
    };

/** Call only after the app has explicitly allocated a new generation. */
export function startSessionCursor(identity: SessionIdentity): SessionCursor {
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) {
    throw new TypeError("Session generation must be a positive safe integer");
  }
  return { ...identity, sequence: 0 };
}

/** Pure admission gate. A future-generation event must never implicitly activate a session. */
export function admitSessionEvent(cursor: SessionCursor, event: SessionEvent): CursorDecision {
  if (event.networkId !== cursor.networkId) return { accepted: false, reason: "wrong-network" };
  if (event.generation !== cursor.generation)
    return { accepted: false, reason: "wrong-generation" };
  if (event.sequence <= cursor.sequence) return { accepted: false, reason: "duplicate" };
  if (!Number.isSafeInteger(event.sequence) || event.sequence !== cursor.sequence + 1) {
    return { accepted: false, reason: "sequence-gap" };
  }
  return { accepted: true, cursor: { ...cursor, sequence: event.sequence } };
}
