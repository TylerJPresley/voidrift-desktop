/**
 * The renderer core-client (desktop-blueprint.md §1.5, §2).
 *
 * A typed wrapper over the two-primitive bridge `window.voidrift` the preload
 * exposes (§1.2). It is the renderer's WHOLE view of the SDK: every action is
 * one `invoke(op, args)` returning the core's `Result<T>` / DTO verbatim, and
 * the event stream arrives through `subscribe`. The renderer never imports
 * `@voidrift/core` and never touches Node (§1.2); it depends only on this
 * client and on the bridge shape.
 */
import type { VoidriftBridge } from "../preload/preload.js";

/** A `Result<T>` as it crosses the bridge (core §2.6) — ok value or CoreError. */
export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; field?: string } };

/** An inert event frame relayed from main (matches the relay's `EventFrame`). */
export interface EventFrame {
  readonly type: string;
  readonly scope: string;
  readonly at: string;
  readonly payload: unknown;
}

/** The window-global the preload installs. */
declare global {
  interface Window {
    voidrift?: VoidriftBridge;
  }
}

/** The approval decision op (matches `RESOLVE_APPROVAL_OP` in core-host). */
export const RESOLVE_APPROVAL_OP = "approvals.resolve";

export class CoreClient {
  constructor(private readonly bridge: VoidriftBridge) {}

  /** Resolve the bridge from the window global, or throw a clear error. */
  static fromWindow(): CoreClient {
    const bridge = typeof window !== "undefined" ? window.voidrift : undefined;
    if (!bridge) throw new Error("voidrift bridge is not available (preload not loaded)");
    return new CoreClient(bridge);
  }

  /** Invoke one CoreAPI op; returns the structured Result/DTO (§2). */
  invoke<T = unknown>(op: string, args: readonly unknown[] = []): Promise<T> {
    return this.bridge.invoke(op, args) as Promise<T>;
  }

  /** Return a renderer approval decision to the main-process broker (§6.1). */
  resolveApproval(response: unknown): Promise<{ ok: boolean }> {
    return this.bridge.invoke(RESOLVE_APPROVAL_OP, [response]) as Promise<{ ok: boolean }>;
  }

  /** Subscribe to the scoped event-frame stream; returns an unsubscribe fn (§2). */
  subscribe(handler: (frame: EventFrame) => void): () => void {
    return this.bridge.subscribe((f) => handler(f as EventFrame));
  }
}
