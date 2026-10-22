/**
 * Renderer reducer tests (desktop-blueprint.md §3).
 */
import { describe, expect, it } from "vitest";
import { appendUserTurn, initialState, reduce, summarizeArgs, type ConversationState } from "./reducer.js";
import type { EventFrame } from "../core-client.js";

function frame(type: string, payload: unknown, scope = "s1"): EventFrame {
  return { type, scope, at: "t", payload };
}

describe("reduce (§3 — events to view state)", () => {
  it("accumulates TOKEN_STREAM then reconciles to TurnResult.text on TURN_COMPLETE", () => {
    let s = reduce(initialState, frame("TOKEN_STREAM", { token: "hel" }));
    s = reduce(s, frame("TOKEN_STREAM", { token: "lo" }));
    expect(s.turns[0]!.text).toBe("hello");
    s = reduce(s, frame("TURN_COMPLETE", { status: "completed", text: "hello (final)" }));
    expect(s.turns[0]!.text).toBe("hello (final)");
    expect(s.turns[0]!.done).toBe(true);
  });

  it("opens and closes a tool row keyed by id, carrying a diff", () => {
    let s = reduce(initialState, frame("TOOL_STARTED", { id: "t1", name: "write", args: { path: "a" } }));
    expect(s.turns[0]!.tools[0]).toMatchObject({ id: "t1", status: "running" });
    s = reduce(s, frame("TOOL_FINISHED", { id: "t1", name: "write", status: "success", summary: "ok", diff: "+x" }));
    expect(s.turns[0]!.tools[0]).toMatchObject({ status: "success", summary: "ok", diff: "+x" });
  });

  it("streams REASONING_STREAM into reasoning (never the committed text)", () => {
    const s = reduce(initialState, frame("REASONING_STREAM", { token: "thinking" }));
    expect(s.turns[0]!.reasoning).toBe("thinking");
    expect(s.turns[0]!.text).toBe("");
  });

  it("marks a cancelled turn and surfaces an error", () => {
    let s = reduce(initialState, frame("TOKEN_STREAM", { token: "x" }));
    s = reduce(s, frame("TURN_CANCELLED", {}));
    expect(s.turns[0]!.cancelled).toBe(true);
    s = reduce(s, frame("ERROR_OCCURRED", { source: "engine", message: "boom" }));
    expect(s.error).toBe("boom");
  });

  it("updates footer fields: context %, model, branch", () => {
    let s = reduce(initialState, frame("CONTEXT_BUDGET_UPDATED", { percentage: 42 }));
    s = reduce(s, frame("MODEL_CHANGED", { name: "gpt" }));
    s = reduce(s, frame("BRANCH_CHANGED", { branch: "main" }, "host"));
    expect(s).toMatchObject({ contextPercentage: 42, modelName: "gpt", branch: "main" });
  });

  it("raises and clears a pending approval", () => {
    let s = reduce(initialState, frame("APPROVAL_REQUESTED", { id: "a1", tool: "write", args: { p: 1 }, choices: ["approve", "reject"] }, "host"));
    expect(s.pending).toMatchObject({ id: "a1", tool: "write" });
    s = reduce(s, frame("PERMISSION_RESOLVED", {}));
    expect(s.pending).toBeNull();
  });

  it("sets and clears the managed-layer lockdown banner (§6.4)", () => {
    let s = reduce(initialState, frame("MANAGED_LAYER_STATUS", { status: "unavailable", reason: "locked" }, "host"));
    expect(s.lockdown).toBe("locked");
    s = reduce(s, frame("MANAGED_LAYER_STATUS", { status: "ok" }, "host"));
    expect(s.lockdown).toBeNull();
  });

  it("appendUserTurn adds a committed user turn", () => {
    const s: ConversationState = appendUserTurn(initialState, "u1", "hi");
    expect(s.turns[0]).toMatchObject({ id: "u1", role: "user", text: "hi", done: true });
  });

  it("summarizeArgs trims to a one-line summary", () => {
    expect(summarizeArgs({ path: "a.txt", n: 3 })).toBe("path=a.txt n=3");
    expect(summarizeArgs(null)).toBe("");
  });

  it("MODEL_ERROR with willRetry sets the retrying flag; TURN_COMPLETE clears it", () => {
    let s = reduce(initialState, frame("MODEL_ERROR", { attempt: 1, willRetry: true }));
    expect(s.retrying).toBe(true);
    s = reduce(s, frame("TURN_COMPLETE", { text: "done" }));
    expect(s.retrying).toBe(false);
  });

  it("an unknown event type is a no-op", () => {
    const s = reduce(initialState, frame("SOMETHING_ELSE", { x: 1 }));
    expect(s).toBe(initialState);
  });

  it("PERMISSION_REQUESTED (core wire name) also raises an approval with requestId", () => {
    const s = reduce(initialState, frame("PERMISSION_REQUESTED", { requestId: "p9", tool: "t", args: {} }, "host"));
    expect(s.pending?.id).toBe("p9");
  });

  it("carries `rememberable: true` into pending state (enables the four-choice set)", () => {
    const s = reduce(
      initialState,
      frame("PERMISSION_REQUESTED", { requestId: "r1", tool: "run_command", args: {}, rememberable: true, inferredPatterns: ["ls *"] }, "host"),
    );
    expect(s.pending?.rememberable).toBe(true);
    expect(s.pending?.inferredPatterns).toEqual(["ls *"]);
  });

  it("carries `rememberable: false` through and omits it when absent (fail closed)", () => {
    const off = reduce(initialState, frame("PERMISSION_REQUESTED", { requestId: "r2", tool: "t", args: {}, rememberable: false }, "host"));
    expect(off.pending?.rememberable).toBe(false);
    const missing = reduce(initialState, frame("PERMISSION_REQUESTED", { requestId: "r3", tool: "t", args: {} }, "host"));
    expect("rememberable" in (missing.pending as object)).toBe(false);
  });

  it("carries `exactOnly: true` and `forceAskKind` into pending state (owner D2b)", () => {
    const s = reduce(
      initialState,
      frame(
        "PERMISSION_REQUESTED",
        { requestId: "e1", tool: "web_fetch", args: { url: "http://127.0.0.1" }, rememberable: true, exactOnly: true, forceAskKind: "ssrf", inferredPatterns: ["127.0.0.1"] },
        "host",
      ),
    );
    expect(s.pending?.exactOnly).toBe(true);
    expect(s.pending?.forceAskKind).toBe("ssrf");
  });

  it("omits `exactOnly`/`forceAskKind` when absent or not a known tag (fail closed)", () => {
    const missing = reduce(initialState, frame("PERMISSION_REQUESTED", { requestId: "e2", tool: "t", args: {} }, "host"));
    expect("exactOnly" in (missing.pending as object)).toBe(false);
    expect("forceAskKind" in (missing.pending as object)).toBe(false);
    const bogus = reduce(initialState, frame("PERMISSION_REQUESTED", { requestId: "e3", tool: "t", args: {}, exactOnly: 1, forceAskKind: "nope" }, "host"));
    expect("exactOnly" in (bogus.pending as object)).toBe(false);
    expect("forceAskKind" in (bogus.pending as object)).toBe(false);
  });
});
