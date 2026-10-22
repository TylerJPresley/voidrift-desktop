/**
 * Event-relay tests (desktop-blueprint.md §1.3, §2).
 */
import { describe, expect, it } from "vitest";
import { EVENT_CHANNEL, HOST_EVENT_TYPES, relayHost, relaySession, toFrame } from "./main/event-relay.js";
import { makeCore } from "./test-harness.js";
import type { WindowHandle } from "./main/electron-host.js";

function recordWindow(): { window: WindowHandle; frames: Array<{ channel: string; payload: unknown }> } {
  const frames: Array<{ channel: string; payload: unknown }> = [];
  return {
    frames,
    window: { send: (channel, payload) => frames.push({ channel, payload }), isFocused: () => true, close: () => {} },
  };
}

describe("scoped relay (§1.3, §2 — session isolation)", () => {
  it("relays only the subscribed session's events, never another session's", async () => {
    const ready = await makeCore();
    const a = await ready.api.session.create();
    const b = await ready.api.session.create();
    const idA = a.ok ? a.value.id : "";
    const idB = b.ok ? b.value.id : "";
    const { window, frames } = recordWindow();
    const unsub = relaySession(ready.api, window, idA);

    ready.api.events.register("TOKEN_STREAM");
    ready.api.events.emit("TOKEN_STREAM", { token: "for-A" }, { session: idA });
    ready.api.events.emit("TOKEN_STREAM", { token: "for-B" }, { session: idB });

    const payloads = frames.map((f) => (f.payload as { payload: { token: string } }).payload.token);
    expect(payloads).toContain("for-A");
    expect(payloads).not.toContain("for-B");
    unsub();
    await ready.api.session.shutdown();
  });
});

describe("host relay (§1.3 — global notices only)", () => {
  it("relays BRANCH_CHANGED / HOUSEKEEPING_NOTICE / MANAGED_LAYER_STATUS and nothing else", async () => {
    const ready = await makeCore();
    const { window, frames } = recordWindow();
    const unsub = relayHost(ready.api, window);

    ready.api.events.register("BRANCH_CHANGED");
    ready.api.events.register("RESOURCE_CHANGED");
    ready.api.events.emit("BRANCH_CHANGED", { branch: "main" }, {});
    ready.api.events.emit("RESOURCE_CHANGED", { type: "mcp" }, {});

    const types = frames.map((f) => (f.payload as { type: string }).type);
    expect(types).toContain("BRANCH_CHANGED");
    expect(types).not.toContain("RESOURCE_CHANGED");
    for (const t of types) expect(HOST_EVENT_TYPES.has(t)).toBe(true);
    unsub();
    await ready.api.session.shutdown();
  });
});

describe("toFrame (§2 — inert JSON frame)", () => {
  it("produces a structured-clonable frame with a resolved scope", () => {
    const frame = toFrame({ type: "TOKEN_STREAM", scope: { session: "abcd1234" }, at: "2026-01-01T00:00:00Z", payload: { token: "x" } } as never);
    expect(frame).toEqual({ type: "TOKEN_STREAM", scope: "abcd1234", at: "2026-01-01T00:00:00Z", payload: { token: "x" } });
    expect(() => structuredClone(frame)).not.toThrow();
  });

  it("defaults scope to host and drops a non-clonable payload", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const frame = toFrame({ type: "X", scope: {}, at: "", payload: circular } as never);
    expect(frame.scope).toBe("host");
    expect(frame.payload).toBeNull();
  });

  it("uses the shared EVENT_CHANNEL constant", () => {
    expect(EVENT_CHANNEL).toBe("voidrift:event");
  });
});
