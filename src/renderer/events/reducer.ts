/**
 * The scoped-event reducer (desktop-blueprint.md §3, §1.1).
 *
 * Turns each relayed `EventFrame` into view state exactly as the CLI, VS Code,
 * and web clients do: TOKEN_STREAM accumulates assistant text, TOOL_STARTED/
 * TOOL_FINISHED open and close tool rows, REASONING_STREAM fills the collapsed
 * reasoning view (never committed), TURN_COMPLETE reconciles to the
 * authoritative `TurnResult.text`, CONTEXT_BUDGET_UPDATED moves the occupancy
 * meter, and PERMISSION/APPROVAL events raise an approval. The renderer computes
 * NOTHING the core owns — it reflects events (§1.1). The reducer is pure.
 */
import type { EventFrame } from "../core-client.js";

export interface ToolRow {
  readonly id: string;
  readonly name: string;
  readonly argsSummary: string;
  readonly status: "running" | "success" | "error";
  readonly summary?: string;
  readonly diff?: string;
}

export interface TranscriptTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly reasoning: string;
  readonly tools: ToolRow[];
  readonly done: boolean;
  readonly cancelled?: boolean;
}

export interface PendingApproval {
  readonly id: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly choices: readonly ("approve" | "edit" | "reject")[];
  readonly workerId?: string;
  readonly inferredPatterns?: readonly string[];
  readonly rememberable?: boolean;
  /** owner D2a — exact-only remember flag (force-ask lift); carried for parity,
   * the D2b desktop UI renders the note. */
  readonly exactOnly?: boolean;
  /** The force-ask family (core §9.5) — `"shell"`, `"ssrf"`, or
   * `"plugin-install"`. The D2b desktop UI uses it to pick the exact-only note
   * wording (command / host / package version). */
  readonly forceAskKind?: "shell" | "ssrf" | "plugin-install" | "control-file";
  readonly diff?: string;
}

export interface ConversationState {
  readonly turns: TranscriptTurn[];
  readonly contextPercentage: number;
  readonly branch: string | null;
  readonly modelName: string;
  readonly pending: PendingApproval | null;
  readonly error: string | null;
  readonly retrying: boolean;
  /** A persistent managed-layer lockdown banner (§6.4), or null. */
  readonly lockdown: string | null;
}

export const initialState: ConversationState = {
  turns: [],
  contextPercentage: 0,
  branch: null,
  modelName: "",
  pending: null,
  error: null,
  retrying: false,
  lockdown: null,
};

/** Append a user turn when the window submits input (§4). */
export function appendUserTurn(state: ConversationState, id: string, text: string): ConversationState {
  const turn: TranscriptTurn = { id, role: "user", text, reasoning: "", tools: [], done: true };
  return { ...state, turns: [...state.turns, turn] };
}

function openAssistant(turns: TranscriptTurn[]): { turns: TranscriptTurn[]; active: TranscriptTurn } {
  const last = turns[turns.length - 1];
  if (last && last.role === "assistant" && !last.done) return { turns, active: last };
  const active: TranscriptTurn = {
    id: `a-${turns.length}`,
    role: "assistant",
    text: "",
    reasoning: "",
    tools: [],
    done: false,
  };
  return { turns: [...turns, active], active };
}

function str(p: Record<string, unknown>, k: string): string {
  const v = p[k];
  return typeof v === "string" ? v : "";
}

function num(p: Record<string, unknown>, k: string): number {
  const v = p[k];
  return typeof v === "number" ? v : 0;
}

/** True when the value is one of the core's force-ask family tags. */
function isForceAskKind(v: unknown): v is "shell" | "ssrf" | "plugin-install" | "control-file" {
  return v === "shell" || v === "ssrf" || v === "plugin-install" || v === "control-file";
}

/** A one-line args summary from the core's already-masked, trimmed args (§3.2). */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ")
    .slice(0, 200);
}

/** Reduce one relayed event frame into new view state (pure, §3). */
export function reduce(state: ConversationState, frame: EventFrame): ConversationState {
  const p = (frame.payload ?? {}) as Record<string, unknown>;
  switch (frame.type) {
    case "TOKEN_STREAM": {
      const { turns, active } = openAssistant(state.turns);
      return { ...state, turns: replace(turns, { ...active, text: active.text + str(p, "token") }) };
    }
    case "REASONING_STREAM": {
      const { turns, active } = openAssistant(state.turns);
      return { ...state, turns: replace(turns, { ...active, reasoning: active.reasoning + str(p, "token") }) };
    }
    case "TOOL_STARTED": {
      const { turns, active } = openAssistant(state.turns);
      const row: ToolRow = { id: str(p, "id"), name: str(p, "name"), argsSummary: summarizeArgs(p["args"]), status: "running" };
      return { ...state, turns: replace(turns, { ...active, tools: [...active.tools, row] }) };
    }
    case "TOOL_FINISHED": {
      const { turns, active } = openAssistant(state.turns);
      const id = str(p, "id");
      const status: ToolRow["status"] = str(p, "status") === "error" ? "error" : "success";
      const tools = active.tools.map((t) =>
        t.id === id
          ? { ...t, status, summary: str(p, "summary"), ...(typeof p["diff"] === "string" ? { diff: p["diff"] as string } : {}) }
          : t,
      );
      return { ...state, turns: replace(turns, { ...active, tools }) };
    }
    case "TURN_COMPLETE": {
      const { turns, active } = openAssistant(state.turns);
      const text = str(p, "text") || active.text;
      return { ...state, turns: replace(turns, { ...active, text, done: true }), pending: null, retrying: false };
    }
    case "TURN_CANCELLED": {
      const last = state.turns[state.turns.length - 1];
      if (last && last.role === "assistant" && !last.done) {
        return { ...state, turns: replace(state.turns, { ...last, done: true, cancelled: true }) };
      }
      return state;
    }
    case "CONTEXT_BUDGET_UPDATED":
      return { ...state, contextPercentage: num(p, "percentage") };
    case "MODEL_CHANGED":
      return { ...state, modelName: str(p, "name") };
    case "BRANCH_CHANGED":
      return { ...state, branch: typeof p["branch"] === "string" ? (p["branch"] as string) : null };
    case "MODEL_ERROR":
      return { ...state, retrying: Boolean(p["willRetry"]) };
    case "APPROVAL_REQUESTED":
    case "PERMISSION_REQUESTED": {
      const pending: PendingApproval = {
        id: str(p, "id") || str(p, "requestId"),
        tool: str(p, "tool"),
        args: (p["args"] as Record<string, unknown>) ?? {},
        choices: (Array.isArray(p["choices"]) ? (p["choices"] as PendingApproval["choices"]) : ["approve", "edit", "reject"]),
        ...(typeof p["workerId"] === "string" ? { workerId: p["workerId"] as string } : {}),
        ...(Array.isArray(p["inferredPatterns"]) ? { inferredPatterns: p["inferredPatterns"] as string[] } : {}),
        ...(typeof p["rememberable"] === "boolean" ? { rememberable: p["rememberable"] as boolean } : {}),
        ...(typeof p["exactOnly"] === "boolean" ? { exactOnly: p["exactOnly"] as boolean } : {}),
        ...(isForceAskKind(p["forceAskKind"]) ? { forceAskKind: p["forceAskKind"] } : {}),
        ...(typeof p["diff"] === "string" ? { diff: p["diff"] as string } : {}),
      };
      return { ...state, pending };
    }
    case "PERMISSION_RESOLVED":
      return { ...state, pending: null };
    case "MANAGED_LAYER_STATUS": {
      const status = str(p, "status");
      return { ...state, lockdown: status === "ok" || status === "none" ? null : str(p, "reason") || "deployment locked down" };
    }
    case "ERROR_OCCURRED":
    case "CONTEXT_OVERFLOW":
      return { ...state, error: str(p, "message"), retrying: false };
    default:
      return state;
  }
}

function replace(turns: TranscriptTurn[], turn: TranscriptTurn): TranscriptTurn[] {
  const idx = turns.findIndex((t) => t.id === turn.id);
  if (idx === -1) return [...turns, turn];
  const copy = turns.slice();
  copy[idx] = turn;
  return copy;
}
