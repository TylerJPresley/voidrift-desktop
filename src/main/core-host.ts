/**
 * The embedded-core host (desktop-blueprint.md §1.2, §1.6, §6, §7).
 *
 * `createCore` runs in the MAIN process (never the renderer) with the
 * consumer-implemented callbacks the app owns — `output`, `openPanel`, and the
 * interactive `onApproval` — and `installSignalHandlers: false` because the app
 * owns its lifecycle through Electron (§1.6). No business logic lives here; the
 * app is a view over the CoreAPI (§1.1).
 */
import {
  createCore,
  type CoreAPI,
  type CoreReady,
  type ResumedSession,
  type SessionInfo,
} from "@voidrift/core";
import type { ApprovalBroker } from "./approvals.js";
import { handleInvoke } from "./ipc.js";
import { registerBuiltinPanels } from "./builtin-panels.js";

/** The special main-side op the renderer uses to return an approval decision. */
export const RESOLVE_APPROVAL_OP = "approvals.resolve";

export interface BootOptions {
  workspaceRoot: string;
  broker: ApprovalBroker;
  /** Relayed to the renderer footer/banner (§1.6 step 2). */
  output?: (text: string) => void;
  openPanel?: (name: string) => void;
  /** Injected in tests (fakeModel + in-memory); omitted in production. */
  configOverrides?: Record<string, unknown>;
  chatModelFactory?: () => unknown;
  sessionRepository?: unknown;
}

/**
 * Construct the embedded core with the app callbacks and signal ownership
 * (§1.6 step 1). Every session is interactive — `onApproval` is supplied — so a
 * gated action blocks until the user answers in the window (§6).
 */
export async function bootCore(opts: BootOptions): Promise<CoreReady> {
  const ready = await createCore({
    workspaceRoot: opts.workspaceRoot,
    installSignalHandlers: false,
    onApproval: opts.broker.onApproval,
    ...(opts.output ? { output: opts.output } : {}),
    ...(opts.openPanel ? { openPanel: opts.openPanel } : {}),
    ...(opts.configOverrides ? { configOverrides: opts.configOverrides } : {}),
    ...(opts.chatModelFactory
      ? { chatModelFactory: opts.chatModelFactory as never }
      : {}),
    ...(opts.sessionRepository ? { sessionRepository: opts.sessionRepository as never } : {}),
  });
  // Panels ship WITH the app (handoff §0.1): register its own built-in
  // declarations through the same `register.panel` seam a plugin uses, right
  // after `createCore`. The main process relays `registry.panels()` to the
  // renderer unchanged.
  registerBuiltinPanels(ready.api);
  return ready;
}

/** How the window opens its first session (§1.6 step 4, §5). */
export type StartMode =
  | { kind: "open" } // honor resumeOnStart
  | { kind: "new" }
  | { kind: "resume"; id: string };

/** The resolved session plus any resume DTO to paint from (§5). */
export interface ResolvedStart {
  session: SessionInfo;
  resumed?: ResumedSession;
}

/**
 * Resolve the session the window opens, mapping one condition to one CoreAPI op
 * (§5). "Most recent" is a client convenience — the app sorts `session.list()`
 * by `lastActiveAt` and resumes by id; the core resolves only by id (core §5.7).
 */
export async function resolveStart(
  api: CoreAPI,
  mode: StartMode,
  resumeOnStart: number,
): Promise<ResolvedStart | { error: string }> {
  if (mode.kind === "new") {
    const r = await api.session.create();
    return r.ok ? { session: r.value } : { error: r.error.message };
  }
  if (mode.kind === "resume") {
    const r = await api.session.resume(mode.id);
    return r.ok ? { session: r.value.info, resumed: r.value } : { error: r.error.message };
  }
  if (resumeOnStart === 1) {
    const list = await api.session.list();
    const sorted = [...list].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    const most = sorted[0];
    if (most) {
      const r = await api.session.resume(most.id);
      return r.ok ? { session: r.value.info, resumed: r.value } : { error: r.error.message };
    }
  }
  const r = await api.session.create();
  return r.ok ? { session: r.value } : { error: r.error.message };
}

/**
 * The single invoke entry the preload bridge reaches (§2). The one app-side op
 * `approvals.resolve` returns a renderer approval decision to the broker; every
 * other op is validated and dispatched to exactly one CoreAPI method
 * (`handleInvoke`). An unknown or hostile intent is dropped as a value.
 */
export function makeInvokeHandler(
  api: CoreAPI,
  broker: ApprovalBroker,
): (raw: unknown) => Promise<unknown> {
  return async (raw: unknown): Promise<unknown> => {
    if (isResolveApproval(raw)) {
      const settled = broker.resolve((raw as { args: unknown[] }).args[0]);
      return { ok: settled };
    }
    return handleInvoke(api, raw);
  };
}

function isResolveApproval(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { op?: unknown }).op === RESOLVE_APPROVAL_OP &&
    Array.isArray((raw as { args?: unknown }).args)
  );
}
