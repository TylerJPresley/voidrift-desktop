/**
 * The main → renderer event relay (desktop-blueprint.md §1.3, §2).
 *
 * Opens scoped core subscriptions (core §14.5) and relays each `EventEnvelope`
 * to a window as an INERT, structured-clonable JSON frame — the only data that
 * crosses the bridge toward the renderer. A scoped subscription receives its
 * session's and its workers' events and NEVER another session's (core §14.5),
 * so a tab is isolated by the core's own scope mechanism, not renderer-side
 * filtering. The host-level unscoped subscription relays only the events that
 * belong to no session — `BRANCH_CHANGED`, `HOUSEKEEPING_NOTICE`,
 * `MANAGED_LAYER_STATUS` (§1.3, core §14.6). The relay adds no logic.
 */
import type { CoreAPI, EventEnvelope } from "@voidrift/core";
import type { WindowHandle } from "./electron-host.js";

/** The IPC channel the preload `subscribe` listens on (one channel, scoped payloads). */
export const EVENT_CHANNEL = "voidrift:event";

/** The host-level event types relayed to every window (core §14.6). */
export const HOST_EVENT_TYPES: ReadonlySet<string> = new Set([
  "BRANCH_CHANGED",
  "HOUSEKEEPING_NOTICE",
  "MANAGED_LAYER_STATUS",
]);

/** A sanitized, inert event frame — JSON only, no entity/LangChain type (§2). */
export interface EventFrame {
  readonly type: string;
  readonly scope: string;
  readonly at: string;
  readonly payload: unknown;
}

/**
 * Reduce an `EventEnvelope` to an inert frame. Structured-cloning the payload
 * strips any accidental non-clonable reference and freezes the shape the
 * renderer sees; the core already emits DTO payloads (core §2), so this is a
 * defensive, allocation-cheap pass, not a transformation.
 */
export function toFrame(ev: EventEnvelope): EventFrame {
  const scope =
    ev.scope && typeof ev.scope === "object" && "session" in ev.scope
      ? String((ev.scope as { session?: unknown }).session ?? "host")
      : "host";
  return {
    type: ev.type,
    scope,
    at: ev.at ?? new Date().toISOString(),
    payload: sanitize(ev.payload),
  };
}

/** Deep-clone to a plain JSON value; anything non-serializable becomes null. */
function sanitize(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

/**
 * Subscribe a window to a session scope and relay its frames (§1.3, §2). The
 * returned function unsubscribes, closing the core subscription.
 */
export function relaySession(api: CoreAPI, window: WindowHandle, sessionId: string): () => void {
  return api.events.subscribe(
    "*",
    (ev) => window.send(EVENT_CHANNEL, toFrame(ev)),
    { scope: { session: sessionId } },
  );
}

/**
 * Subscribe to the host-level events (no session scope) and relay the three
 * global notices to the window (§1.3, core §14.6). Other unscoped events are
 * dropped — the renderer only needs the window-chrome notices here.
 */
export function relayHost(api: CoreAPI, window: WindowHandle): () => void {
  return api.events.subscribe("*", (ev) => {
    if (HOST_EVENT_TYPES.has(ev.type)) window.send(EVENT_CHANNEL, toFrame(ev));
  });
}
