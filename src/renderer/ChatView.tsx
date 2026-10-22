/**
 * The transcript and status chrome (desktop-blueprint.md §3).
 *
 * Renders turns from reduced view state. The conversation is a labeled `log`
 * region with a polite `aria-live` so a screen reader follows the agent without
 * re-reading (§3, WCAG). ALL text that originates outside the app — tokens,
 * reasoning, tool summaries, diffs, errors — is rendered as TEXT content in
 * React (never `dangerouslySetInnerHTML`), so untrusted content is inert and
 * cannot inject markup or script (§3); the renderer CSP closes the same path
 * structurally. Color is never the sole carrier of state (§3, §9).
 */
import { useState } from "react";
import type { ConversationState, ToolRow, TranscriptTurn } from "./events/reducer.js";
import { sanitizeText } from "./sanitize-text.js";

export function ChatView(props: { readonly state: ConversationState }): React.JSX.Element {
  return (
    <main>
      <section aria-label="Conversation" role="log" aria-live="polite" aria-relevant="additions text">
        {props.state.turns.map((turn) => (
          <TurnArticle key={turn.id} turn={turn} />
        ))}
      </section>
      {props.state.error ? (
        <p role="alert" data-source="error" dir="auto">
          {sanitizeText(props.state.error)}
        </p>
      ) : null}
      {props.state.retrying ? <p role="status">Retrying…</p> : null}
    </main>
  );
}

function TurnArticle({ turn }: { turn: TranscriptTurn }): React.JSX.Element {
  return (
    <article aria-label={`${turn.role} message`}>
      <StreamingMessage text={turn.text} />
      {turn.cancelled ? <span data-marker="cancelled"> (cancelled)</span> : null}
      {turn.reasoning ? <ReasoningView text={turn.reasoning} /> : null}
      {turn.tools.map((t) => (
        <ToolGroup key={t.id} tool={t} />
      ))}
    </article>
  );
}

/** The streamed assistant text; rendered as inert text (§3). */
export function StreamingMessage({ text }: { text: string }): React.JSX.Element {
  return <p dir="auto">{sanitizeText(text)}</p>;
}

/** A collapsed reasoning disclosure; transient, never committed (§3.2). */
export function ReasoningView({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details open={open}>
      <summary onClick={() => setOpen((o) => !o)}>Reasoning</summary>
      <pre dir="auto">{sanitizeText(text)}</pre>
    </details>
  );
}

/** A tool-call row keyed by id; opens running, closes with glyph + summary (§3.2). */
export function ToolGroup({ tool }: { tool: ToolRow }): React.JSX.Element {
  return (
    <div role="group" aria-label={`Tool ${tool.name} ${tool.status}`}>
      <span>
        {statusIcon(tool.status)} {tool.name} — {tool.status}
      </span>
      <span dir="auto">{sanitizeText(tool.argsSummary)}</span>
      {tool.diff ? <DiffView diff={tool.diff} /> : null}
      {tool.summary ? <span dir="auto">{sanitizeText(tool.summary)}</span> : null}
    </div>
  );
}

/** A colored diff view (§3.2). Each line carries a textual +/- marker so color
 * is never the sole carrier of meaning (§3, §9 contrast). */
export function DiffView({ diff }: { diff: string }): React.JSX.Element {
  const lines = diff.split("\n");
  return (
    <pre aria-label="diff">
      {lines.map((line, i) => {
        const kind = line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context";
        return (
          <div key={i} data-diff={kind} dir="auto">
            {sanitizeText(line)}
          </div>
        );
      })}
    </pre>
  );
}

/** The per-tab footer, assembled from events and DTOs (§3.3). */
export function Footer(props: { readonly state: ConversationState; readonly sessionId: string }): React.JSX.Element {
  const { state } = props;
  return (
    <footer aria-label="Status">
      <span data-field="model">{state.modelName || "no model"}</span>
      <span
        role="progressbar"
        aria-label="Context occupancy"
        aria-valuenow={Math.round(state.contextPercentage)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        Context: {Math.round(state.contextPercentage)}%
      </span>
      <span data-field="branch">{state.branch ?? "no branch"}</span>
      <span data-field="session">{props.sessionId.slice(0, 8)}</span>
    </footer>
  );
}

function statusIcon(status: ToolRow["status"]): string {
  if (status === "running") return "…";
  if (status === "error") return "✗";
  return "✓";
}
