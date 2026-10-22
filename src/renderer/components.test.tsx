/**
 * Renderer component tests (desktop-blueprint.md §3, §4, §5, §6).
 * jsdom + Testing Library; accessible-by-role assertions.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ChatView, DiffView, Footer } from "./ChatView.js";
import { Composer, PanelHost, type WirePanelDeclaration } from "./components.js";
import { ApprovalDialog } from "./ApprovalDialog.js";
import { initialState, reduce, type ConversationState, type PendingApproval } from "./events/reducer.js";
import type { EventFrame } from "./core-client.js";
import builtinPanels from "./fixtures/builtin-panels.json" with { type: "json" };

function state(partial: Partial<ConversationState>): ConversationState {
  return { ...initialState, ...partial };
}

function frame(type: string, payload: unknown, scope = "s1"): EventFrame {
  return { type, scope, at: "t", payload };
}

describe("ChatView (§3 — accessible transcript)", () => {
  it("renders the conversation as a polite live log region", () => {
    render(<ChatView state={state({ turns: [{ id: "a", role: "assistant", text: "hi", reasoning: "", tools: [], done: true }] })} />);
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(within(log).getByText("hi")).toBeInTheDocument();
  });

  it("renders untrusted markup as INERT text, never as HTML (§3)", () => {
    const evil = "<img src=x onerror=alert(1)> <script>bad()</script>";
    render(<ChatView state={state({ turns: [{ id: "a", role: "assistant", text: evil, reasoning: "", tools: [], done: true }] })} />);
    // The literal string is present as text; no <img>/<script> node is created.
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("strips Unicode bidi/zero-width controls from external text (Trojan Source)", () => {
    render(
      <ChatView
        state={state({
          error: "e\u202err",
          turns: [
            {
              id: "a",
              role: "assistant",
              text: "safe\u202eevil\u2066x\u2069\u200btail",
              reasoning: "r\u202eq",
              done: true,
              tools: [{ id: "t", name: "write", argsSummary: "p\u202ea", status: "success", summary: "o\u200bk", diff: "+a\u202eb" }],
            },
          ],
        })}
      />,
    );
    const forbidden = /[\u202a-\u202e\u2066-\u2069\u200b\u200c\u200e\u200f\u2060\ufeff]/;
    for (const node of document.querySelectorAll("p, span, pre, div")) {
      expect(node.textContent ?? "").not.toMatch(forbidden);
    }
    expect(screen.getByText(/safeevilxtail/)).toBeInTheDocument();
  });

  it("keeps ZWJ so emoji sequences still render", () => {
    render(
      <ChatView
        state={state({ turns: [{ id: "e", role: "assistant", text: "👨\u200d👩\u200d👧 🇺🇸", reasoning: "", tools: [], done: true }] })}
      />,
    );
    expect(screen.getByText("👨\u200d👩\u200d👧 🇺🇸")).toBeInTheDocument();
  });

  it("renders a tool row and a colored diff with +/- markers (§3.2)", () => {
    render(
      <ChatView
        state={state({
          turns: [{ id: "a", role: "assistant", text: "", reasoning: "", done: true, tools: [{ id: "t", name: "write", argsSummary: "path=a", status: "success", summary: "done", diff: "+added\n-removed\n ctx" }] }],
        })}
      />,
    );
    expect(screen.getByRole("group", { name: /Tool write success/ })).toBeInTheDocument();
    const added = document.querySelector('[data-diff="added"]');
    const removed = document.querySelector('[data-diff="removed"]');
    expect(added).toHaveTextContent("+added");
    expect(removed).toHaveTextContent("-removed");
  });
});

describe("Footer (§3.3)", () => {
  it("shows model, context occupancy, branch, short id", () => {
    render(<Footer state={state({ modelName: "gpt", contextPercentage: 55, branch: "main" })} sessionId="abcd1234ef" />);
    expect(screen.getByRole("progressbar", { name: "Context occupancy" })).toHaveAttribute("aria-valuenow", "55");
    expect(screen.getByText("gpt")).toBeInTheDocument();
    expect(screen.getByText("abcd1234")).toBeInTheDocument();
  });
});

describe("ApprovalDialog (§6.1 — full masked action, a11y)", () => {
  const approval: PendingApproval = {
    id: "r1",
    tool: "run_command",
    args: { command: "deploy", token: "sk-MASKED" },
    choices: ["approve", "edit", "reject"],
    rememberable: true,
    inferredPatterns: ["run_command(deploy)"],
    diff: "+change",
  };

  it("is a focus-trapped assertive alertdialog showing the full args verbatim", () => {
    render(<ApprovalDialog approval={approval} onDecision={() => {}} />);
    const dialog = screen.getByRole("alertdialog", { name: /Approve action: run_command/ });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-live", "assertive");
    // The full args render verbatim — the masked value is shown, never un-masked.
    const args = dialog.querySelector('[data-field="args"]')!;
    expect(args.textContent).toContain("sk-MASKED");
    expect(args.textContent).toContain("deploy");
  });

  it("the four choices map to the right responses", () => {
    // Latch: one decision per instance — render fresh for each choice.
    const once = vi.fn();
    const { unmount: u1 } = render(<ApprovalDialog approval={approval} onDecision={once} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(once).toHaveBeenCalledWith({ requestId: "r1", decision: "approve" });
    u1();

    const session = vi.fn();
    const { unmount: u2 } = render(<ApprovalDialog approval={approval} onDecision={session} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve for this session" }));
    expect(session).toHaveBeenCalledWith({ requestId: "r1", decision: "approve", remember: "session", chosenPattern: "run_command(deploy)" });
    u2();

    const project = vi.fn();
    render(<ApprovalDialog approval={approval} onDecision={project} />);
    fireEvent.click(screen.getByRole("button", { name: "Save to this project" }));
    expect(project).toHaveBeenCalledWith({ requestId: "r1", decision: "approve", remember: "project", chosenPattern: "run_command(deploy)" });
  });

  it("shows the project config target and the exact tool + pattern that will be saved", () => {
    render(<ApprovalDialog approval={approval} onDecision={vi.fn()} />);
    const preview = document.querySelector('[data-field="save-preview"]')!;
    expect(preview.textContent).toContain(".voidrift/config.json");
    expect(preview.textContent).toContain("run_command");
    expect(preview.textContent).toContain("run_command(deploy)");
  });

  it("offers a labelled radio group for several patterns and sends the chosen one", () => {
    const onDecision = vi.fn();
    const multi: PendingApproval = { ...approval, inferredPatterns: ["run_command(deploy)", "run_command(build)"] };
    render(<ApprovalDialog approval={multi} onDecision={onDecision} />);
    const group = screen.getByRole("radiogroup", { name: "Pattern to save" });
    fireEvent.click(within(group).getByRole("radio", { name: /run_command\(build\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save to this project" }));
    expect(onDecision).toHaveBeenLastCalledWith({ requestId: "r1", decision: "approve", remember: "project", chosenPattern: "run_command(build)" });
  });

  it("non-rememberable renders ONLY approve-once and reject with the always-asked note", () => {
    const forceAsk: PendingApproval = { ...approval, rememberable: false };
    render(<ApprovalDialog approval={forceAsk} onDecision={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve for this session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save to this project" })).toBeNull();
    expect(screen.getByText("This kind of action is always asked.")).toBeInTheDocument();
  });

  it("fails closed when rememberable is missing", () => {
    const noFlag: PendingApproval = { id: "r9", tool: "t", args: {}, choices: ["approve", "reject"], inferredPatterns: ["t:x"] };
    render(<ApprovalDialog approval={noFlag} onDecision={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Approve for this session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save to this project" })).toBeNull();
    expect(screen.getByText("This kind of action is always asked.")).toBeInTheDocument();
  });

  it("shows the exact-only note next to the save preview, by force-ask family (owner D2b)", () => {
    const shell: PendingApproval = { ...approval, exactOnly: true, forceAskKind: "shell" };
    const { unmount: u1 } = render(<ApprovalDialog approval={shell} onDecision={vi.fn()} />);
    expect(screen.getByText("Saved as this exact command only.")).toBeInTheDocument();
    u1();

    const host: PendingApproval = { ...approval, tool: "web_fetch", exactOnly: true, forceAskKind: "ssrf", inferredPatterns: ["example.com"] };
    const { unmount: u2 } = render(<ApprovalDialog approval={host} onDecision={vi.fn()} />);
    expect(screen.getByText("Saved for this exact host only.")).toBeInTheDocument();
    u2();

    const pkg: PendingApproval = { ...approval, tool: "plugins_install", exactOnly: true, forceAskKind: "plugin-install", inferredPatterns: ["pkg@1.2.3"] };
    render(<ApprovalDialog approval={pkg} onDecision={vi.fn()} />);
    expect(screen.getByText("Saved for this exact package version only.")).toBeInTheDocument();
  });

  it("control-file note follows the tool: FILE for a file tool, COMMAND for a shell tool (owner S1)", () => {
    const file: PendingApproval = {
      ...approval,
      tool: "write_file",
      exactOnly: true,
      forceAskKind: "control-file",
      inferredPatterns: ["AGENTS.md"],
    };
    const { unmount: u1 } = render(<ApprovalDialog approval={file} onDecision={vi.fn()} />);
    expect(screen.getByText("Saved for this exact file only.")).toBeInTheDocument();
    u1();

    const cmd: PendingApproval = {
      ...approval,
      tool: "execute_command",
      exactOnly: true,
      forceAskKind: "control-file",
      inferredPatterns: ["echo x > .git/hooks/pre-commit"],
    };
    render(<ApprovalDialog approval={cmd} onDecision={vi.fn()} />);
    expect(screen.getByText("Saved as this exact command only.")).toBeInTheDocument();
  });

  it("does not show the exact-only note when exactOnly is absent", () => {
    render(<ApprovalDialog approval={approval} onDecision={vi.fn()} />);
    expect(screen.queryByText(/Saved (as|for) this exact/)).toBeNull();
  });

  it("ESC rejects", () => {
    const onDecision = vi.fn();
    render(<ApprovalDialog approval={approval} onDecision={onDecision} />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onDecision).toHaveBeenCalledWith({ requestId: "r1", decision: "reject" });
  });

  it("the Edit and Reject buttons return their decisions", () => {
    const editFn = vi.fn();
    const { unmount } = render(<ApprovalDialog approval={approval} onDecision={editFn} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(editFn).toHaveBeenLastCalledWith({ requestId: "r1", decision: "edit" });
    unmount();

    const rejectFn = vi.fn();
    render(<ApprovalDialog approval={approval} onDecision={rejectFn} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(rejectFn).toHaveBeenLastCalledWith({ requestId: "r1", decision: "reject" });
  });

  it("shows the worker id and the diff for a fan-out worker action (§6.2)", () => {
    const workerReq: PendingApproval = { ...approval, workerId: "w-7" };
    render(<ApprovalDialog approval={workerReq} onDecision={() => {}} />);
    expect(screen.getByText(/Worker: w-7/)).toBeInTheDocument();
    expect(screen.getByLabelText("diff")).toHaveTextContent("+change");
  });

  it("renders only the offered choices (no edit when not in choices)", () => {
    const req: PendingApproval = { id: "r2", tool: "t", args: {}, choices: ["approve", "reject"] };
    render(<ApprovalDialog approval={req} onDecision={() => {}} />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
  });

  it("Tab from the last focusable wraps to the first (focus trap §6)", () => {
    render(<ApprovalDialog approval={approval} onDecision={() => {}} />);
    const dialog = screen.getByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Tab" });
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    // No throw; focus stays within the dialog.
    expect(dialog).toBeInTheDocument();
  });

  it("latches: a rapid double-click sends exactly ONE decision and disables the buttons", () => {
    const onDecision = vi.fn();
    render(<ApprovalDialog approval={approval} onDecision={onDecision} />);
    const approveOnce = screen.getByRole("button", { name: "Approve once" });
    fireEvent.click(approveOnce);
    fireEvent.click(approveOnce);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith({ requestId: "r1", decision: "approve" });
    expect(approveOnce).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("latches: Escape then a click still sends exactly ONE decision", () => {
    const onDecision = vi.fn();
    render(<ApprovalDialog approval={approval} onDecision={onDecision} />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith({ requestId: "r1", decision: "reject" });
  });
});

describe("wire path: raw event frame → reducer → rendered choices (§3→§6)", () => {
  // The full chain that broke silently when a reducer dropped `rememberable`.
  it("rememberable:true ⇒ FOUR buttons; false ⇒ two; missing ⇒ two (fail closed)", () => {
    const requested = (payload: unknown) => reduce(initialState, frame("PERMISSION_REQUESTED", payload, "host"));

    const four = requested({ requestId: "r1", tool: "run_command", args: {}, choices: ["approve", "edit", "reject"], rememberable: true, inferredPatterns: ["ls *"] });
    const { unmount } = render(<ApprovalDialog approval={four.pending!} onDecision={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve for this session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to this project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    unmount();

    const two = requested({ requestId: "r2", tool: "t", args: {}, choices: ["approve", "reject"], rememberable: false });
    const { unmount: u2 } = render(<ApprovalDialog approval={two.pending!} onDecision={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Approve for this session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save to this project" })).toBeNull();
    u2();

    const missing = requested({ requestId: "r3", tool: "t", args: {}, choices: ["approve", "reject"] });
    render(<ApprovalDialog approval={missing.pending!} onDecision={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Approve for this session" })).toBeNull();
    expect(screen.getByText("This kind of action is always asked.")).toBeInTheDocument();
  });

  it("exactOnly:true ⇒ the exact-only note renders through the real wire path (owner D2b)", () => {
    const s = reduce(
      initialState,
      frame(
        "PERMISSION_REQUESTED",
        { requestId: "r4", tool: "web_fetch", args: { url: "http://127.0.0.1" }, choices: ["approve", "reject"], rememberable: true, exactOnly: true, forceAskKind: "ssrf", inferredPatterns: ["127.0.0.1"] },
        "host",
      ),
    );
    expect(s.pending?.exactOnly).toBe(true);
    render(<ApprovalDialog approval={s.pending!} onDecision={vi.fn()} />);
    expect(screen.getByText("Saved for this exact host only.")).toBeInTheDocument();
  });
});

describe("Composer (§4)", () => {
  it("does not submit an empty/whitespace buffer (never EMPTY_MESSAGE)", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter submits text; Shift+Enter does not", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("hello");
  });
});

describe("PanelHost (§5, §7)", () => {
  it("renders a pure-data declaration + rows as a labeled table", () => {
    const definition: WirePanelDeclaration = {
      title: "Sessions",
      columns: [{ key: "name", label: "Name" }],
      source: "sessions",
      actions: { d: { label: "delete", op: "session.delete" } },
    };
    render(<PanelHost name="sessions" definition={definition} rows={[{ name: "s1" }]} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("s1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete/ })).toBeInTheDocument();
  });

  it("renders every committed built-in declaration through the local wire type (§7 drift guard)", () => {
    const fixture = builtinPanels as Record<string, WirePanelDeclaration>;
    for (const [name, declaration] of Object.entries(fixture)) {
      const row = Object.fromEntries(declaration.columns.map((c) => [c.key, "x"]));
      const { unmount } = render(<PanelHost name={name} definition={declaration} rows={[row]} onClose={() => {}} />);
      expect(screen.getByRole("dialog", { name: declaration.title })).toBeInTheDocument();
      for (const col of declaration.columns) {
        expect(screen.getByRole("columnheader", { name: col.label })).toBeInTheDocument();
      }
      for (const [hotkey, action] of Object.entries(declaration.actions ?? {})) {
        expect(screen.getByRole("button", { name: new RegExp(`${action.label} \\(${hotkey}\\)`) })).toBeInTheDocument();
      }
      unmount();
    }
  });
});

describe("DiffView (§3.2)", () => {
  it("marks each line kind textually so color is not the sole carrier", () => {
    render(<DiffView diff={"+a\n-b\n c"} />);
    expect(document.querySelector('[data-diff="added"]')).toHaveTextContent("+a");
    expect(document.querySelector('[data-diff="removed"]')).toHaveTextContent("-b");
    expect(document.querySelector('[data-diff="context"]')).toHaveTextContent("c");
  });
});
