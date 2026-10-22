/**
 * Renderer core-client + App shell tests (desktop-blueprint.md §1.1, §2, §4, §6).
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CoreClient, type EventFrame } from "./core-client.js";
import { App } from "./App.js";
import type { VoidriftBridge } from "../preload/preload.js";

function fakeBridge(): { bridge: VoidriftBridge; invokes: Array<{ op: string; args: readonly unknown[] }>; emit: (f: EventFrame) => void } {
  const invokes: Array<{ op: string; args: readonly unknown[] }> = [];
  let handler: ((f: unknown) => void) | undefined;
  const bridge: VoidriftBridge = {
    invoke: (op, args = []) => {
      invokes.push({ op, args });
      return Promise.resolve({ ok: true });
    },
    subscribe: (h) => {
      handler = h;
      return () => (handler = undefined);
    },
  };
  return { bridge, invokes, emit: (f) => handler?.(f) };
}

describe("CoreClient (§2 — the renderer's only SDK path)", () => {
  it("invoke forwards op + args; resolveApproval uses the approvals.resolve op", async () => {
    const { bridge, invokes } = fakeBridge();
    const client = new CoreClient(bridge);
    await client.invoke("session.list");
    await client.resolveApproval({ requestId: "r", decision: "approve" });
    expect(invokes[0]).toMatchObject({ op: "session.list", args: [] });
    expect(invokes[1]).toMatchObject({ op: "approvals.resolve", args: [{ requestId: "r", decision: "approve" }] });
  });

  it("fromWindow throws a clear error when the bridge is absent", () => {
    expect(() => CoreClient.fromWindow()).toThrow(/bridge is not available/);
  });
});

describe("App (§1.1 — one CoreAPI op per action)", () => {
  it("a submit appends a user turn and calls session.send exactly once", () => {
    const { bridge, invokes } = fakeBridge();
    render(<App client={new CoreClient(bridge)} sessionId="sess-1234" />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi there" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const sends = invokes.filter((i) => i.op === "session.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.args).toEqual(["sess-1234", { input: "hi there" }]);
    expect(screen.getByText("hi there")).toBeInTheDocument();
  });

  it("a slash command dispatches session.command, not session.send", () => {
    const { bridge, invokes } = fakeBridge();
    render(<App client={new CoreClient(bridge)} sessionId="s" />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "/help" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(invokes.some((i) => i.op === "session.command")).toBe(true);
    expect(invokes.some((i) => i.op === "session.send")).toBe(false);
  });

  it("a relayed approval event raises the dialog; a decision routes approvals.resolve", async () => {
    const { bridge, invokes, emit } = fakeBridge();
    render(<App client={new CoreClient(bridge)} sessionId="s" />);
    emit({ type: "APPROVAL_REQUESTED", scope: "host", at: "t", payload: { id: "r1", tool: "write", args: { p: 1 }, choices: ["approve", "reject"] } });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(invokes.some((i) => i.op === "approvals.resolve")).toBe(true);
  });

  it("renders the managed-layer lockdown banner from a relayed status", async () => {
    const { bridge, emit } = fakeBridge();
    render(<App client={new CoreClient(bridge)} sessionId="s" />);
    emit({ type: "MANAGED_LAYER_STATUS", scope: "host", at: "t", payload: { status: "unavailable", reason: "policy down" } });
    expect(await screen.findByText("policy down")).toBeInTheDocument();
  });
});
