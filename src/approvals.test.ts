/**
 * Approvals + core-host wiring tests (desktop-blueprint.md §6, §1.6).
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@voidrift/core";
import { ApprovalBroker, parseApprovalResponse } from "./main/approvals.js";
import { bootCore, makeInvokeHandler, resolveStart, RESOLVE_APPROVAL_OP } from "./main/core-host.js";
import { makeCore } from "./test-harness.js";

const sampleReq: PendingApproval = {
  id: "req-1",
  tool: "write_file",
  args: { path: "a.txt", content: "hello", token: "sk-REDACTED" },
  choices: ["approve", "edit", "reject"],
  mode: "interactive",
  inferredPatterns: ["write_file(a.txt)"],
  diff: "+hello",
};

describe("ApprovalBroker (§6.1)", () => {
  it("presents the full, already-masked action VERBATIM and resolves on decision", async () => {
    const presented: PendingApproval[] = [];
    const broker = new ApprovalBroker({ present: (req) => presented.push(req) });
    const promise = broker.onApproval(sampleReq);

    // The presented request is the exact object — no reconstruction/un-masking.
    expect(presented[0]).toBe(sampleReq);
    expect(presented[0]!.args["token"]).toBe("sk-REDACTED");

    const settled = broker.resolve({ requestId: "req-1", decision: "approve" });
    expect(settled).toBe(true);
    await expect(promise).resolves.toEqual({ requestId: "req-1", decision: "approve" });
    expect(broker.size).toBe(0);
  });

  it("ignores an unknown or malformed decision (turn stays blocked)", () => {
    const broker = new ApprovalBroker({ present: () => {} });
    void broker.onApproval(sampleReq);
    expect(broker.resolve({ requestId: "other", decision: "approve" })).toBe(false);
    expect(broker.resolve({ nonsense: true })).toBe(false);
    expect(broker.size).toBe(1);
  });
});

describe("parseApprovalResponse (§6.1)", () => {
  it("accepts a valid decision with remember + pattern", () => {
    const r = parseApprovalResponse({ requestId: "x", decision: "approve", remember: "project", chosenPattern: "p" });
    expect(r).toMatchObject({ decision: "approve", remember: "project" });
  });
  it.each([
    ["bad decision", { requestId: "x", decision: "nuke" }],
    ["missing requestId", { decision: "approve" }],
    ["extra property", { requestId: "x", decision: "approve", evil: 1 }],
    ["bad remember", { requestId: "x", decision: "approve", remember: "global" }],
  ])("rejects %s", (_l, raw) => {
    expect(parseApprovalResponse(raw)).toBeNull();
  });
});

describe("makeInvokeHandler (§6.1 — approvals.resolve round-trip)", () => {
  it("routes approvals.resolve to the broker and CoreAPI ops to the core", async () => {
    const ready = await makeCore();
    const broker = new ApprovalBroker({ present: () => {} });
    const resolveSpy = vi.spyOn(broker, "resolve");
    const handler = makeInvokeHandler(ready.api, broker);

    await handler({ op: RESOLVE_APPROVAL_OP, args: [{ requestId: "r", decision: "reject" }] });
    expect(resolveSpy).toHaveBeenCalledWith({ requestId: "r", decision: "reject" });

    const listed = (await handler({ op: "session.list", args: [] })) as unknown[];
    expect(Array.isArray(listed)).toBe(true);
    await ready.api.session.shutdown();
  });
});

describe("bootCore + resolveStart (§1.6)", () => {
  it("boots an embedded core with onApproval and installSignalHandlers false", async () => {
    const broker = new ApprovalBroker({ present: () => {} });
    const ready = await bootCore({
      workspaceRoot: hermeticTmp("desktop-boot"),
      broker,
      configOverrides: { models: { test: { model: "m", protocol: "openai", contextLimit: 1000 } }, modelSelected: "test" } as never,
      chatModelFactory: (() => {
        // minimal fake chat model factory is not needed for a create/list test
        return {};
      }) as never,
    });
    expect(ready.api).toBeDefined();
    const start = await resolveStart(ready.api, { kind: "new" }, 0);
    expect("session" in start).toBe(true);
    await ready.api.session.shutdown();
  });

  it("resolveStart('open') creates a session when none exist", async () => {
    const ready = await makeCore();
    const start = await resolveStart(ready.api, { kind: "open" }, 1);
    expect("session" in start).toBe(true);
    await ready.api.session.shutdown();
  });

  it("resolveStart('resume') on a missing id returns an error", async () => {
    const ready = await makeCore();
    const start = await resolveStart(ready.api, { kind: "resume", id: "missing" }, 0);
    expect("error" in start).toBe(true);
    await ready.api.session.shutdown();
  });

  it("resolveStart('open') resumes the most recent session when one exists", async () => {
    const ready = await makeCore();
    const created = await ready.api.session.create();
    const id = created.ok ? created.value.id : "";
    const start = await resolveStart(ready.api, { kind: "open" }, 1);
    expect("session" in start && start.session.id).toBe(id);
    await ready.api.session.shutdown();
  });
});
