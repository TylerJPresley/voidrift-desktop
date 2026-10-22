/**
 * Intent validation and the CoreAPI op allow-list (desktop-blueprint.md §2).
 *
 * EVERY renderer → main message is a `{ op, args }` intent validated here with
 * Zod before it reaches the core. `parseIntent` drops a hostile, unknown, or
 * malformed message (returns an `UNKNOWN_OP` / `INVALID_INTENT` CoreError value,
 * never a throw). A valid op maps to EXACTLY ONE namespaced CoreAPI method
 * (§1.1, §2): the bridge adds no logic, chains nothing, and synthesizes no
 * behavior the core does not offer. An op off the allow-list returns
 * `UNKNOWN_OP` WITHOUT reaching the core.
 *
 * Because every CoreAPI operation already returns a `Result<T>` or a DTO and
 * never throws across the boundary (core §2.6), the dispatcher forwards the
 * structured value verbatim and no exception crosses the IPC seam.
 */
import { z } from "zod";
import type { CoreAPI } from "@voidrift/core";

/** The structured error the bridge returns in place of a throw (core §2.6). */
export interface BridgeError {
  readonly code: "UNKNOWN_OP" | "INVALID_INTENT";
  readonly message: string;
  readonly field?: string;
}

/** A validated intent: one allow-listed op name and its positional args. */
export interface Intent {
  readonly op: AllowedOp;
  readonly args: readonly unknown[];
}

/**
 * The allow-list of CoreAPI operations the renderer may invoke, each a dotted
 * `namespace.method` path mapped to exactly one method (§2). Only operations a
 * thin client legitimately needs are listed; everything else is denied. No
 * `register.*`, no `events.*` (events flow one-way over `subscribe`), no
 * internal seam is reachable.
 */
export const ALLOWED_OPS = [
  // sessions (§5)
  "session.create",
  "session.resume",
  "session.list",
  "session.rename",
  "session.delete",
  "session.send",
  "session.confirm",
  "session.cancel",
  "session.clear",
  "session.loadMessages",
  "session.listCommands",
  "session.command",
  // models (§5)
  "models.list",
  "models.switch",
  "models.stats",
  "models.context",
  // agents (§5)
  "agents.list",
  "agents.activate",
  "agents.tools",
  // workspace (§3, §4)
  "workspace.root",
  "workspace.branch",
  "workspace.files",
  "workspace.diff",
  // config (§9)
  "config.get",
  // permissions (§6)
  "permissions.approvals",
  // subagents / monitor (§6.2)
  "subagents.list",
  "subagents.status",
  "subagents.stream",
  // mcp (§7 — non-secret config only; secrets never cross the bridge)
  "mcp.list",
  "mcp.listConfigs",
  "mcp.connect",
  "mcp.disconnect",
  "mcp.saveConfig",
  "mcp.removeConfig",
] as const;

export type AllowedOp = (typeof ALLOWED_OPS)[number];

const allowedSet: ReadonlySet<string> = new Set(ALLOWED_OPS);

/** The wire schema: a non-empty op string and an array of structured-clone args. */
const intentSchema = z.object({
  op: z.string().min(1),
  args: z.array(z.unknown()).max(8).default([]),
});

/**
 * Validate a raw renderer message into an `Intent`, or a `BridgeError` value.
 * Hostile shapes (missing op, non-array args, prototype-pollution keys, extra
 * properties) are dropped by Zod; an unknown op is `UNKNOWN_OP`.
 */
export function parseIntent(raw: unknown): Intent | BridgeError {
  const parsed = intentSchema.strict().safeParse(raw);
  if (!parsed.success) {
    return { code: "INVALID_INTENT", message: "intent failed validation", field: "op" };
  }
  const { op, args } = parsed.data;
  if (!allowedSet.has(op)) {
    return { code: "UNKNOWN_OP", message: `operation "${op}" is not on the allow-list`, field: "op" };
  }
  return { op: op as AllowedOp, args };
}

/** Narrow a parsed value to a `BridgeError`. */
export function isBridgeError(v: Intent | BridgeError): v is BridgeError {
  return "code" in v;
}

/**
 * Resolve a dotted op path to its bound CoreAPI method. Returns null if the
 * path does not resolve to a function (defense-in-depth; the allow-list already
 * guarantees it). The lookup walks the fixed namespaces only.
 */
function resolveMethod(api: CoreAPI, op: AllowedOp): ((...a: unknown[]) => unknown) | null {
  const segments = op.split(".");
  // The surface is at most `namespace.method`; nothing deeper is allow-listed.
  let node: unknown = api;
  for (const seg of segments) {
    if (node == null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === "function" ? (node as (...a: unknown[]) => unknown) : null;
}

/**
 * Dispatch a validated intent to its single CoreAPI op and return the
 * `Result<T>` / DTO verbatim (§2). An op that fails to resolve returns
 * `UNKNOWN_OP`; a method that rejects is caught and returned as a value so no
 * exception crosses IPC.
 */
export async function dispatchIntent(api: CoreAPI, intent: Intent): Promise<unknown> {
  const method = resolveMethod(api, intent.op);
  if (!method) {
    return { ok: false, error: { code: "UNKNOWN_OP", message: `operation "${intent.op}" is not available` } };
  }
  try {
    return await method(...intent.args);
  } catch (e) {
    // CoreAPI never throws across the boundary (core §2.6); this is pure
    // defense-in-depth so a renderer never sees a rejected IPC call.
    return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
  }
}

/**
 * The main-process invoke entry (§2): parse, then dispatch. A hostile message
 * returns a structured error value and NEVER reaches the core.
 */
export async function handleInvoke(api: CoreAPI, raw: unknown): Promise<unknown> {
  const intent = parseIntent(raw);
  if (isBridgeError(intent)) {
    return { ok: false, error: intent };
  }
  return dispatchIntent(api, intent);
}
