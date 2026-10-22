/**
 * The window shell (desktop-blueprint.md §1.1, §3, §4, §6).
 *
 * View state only (§1.1): it subscribes to the scoped event stream, reduces
 * each frame into `ConversationState`, and renders the transcript, composer,
 * footer, approval dialog, and lockdown banner. Every user action maps to
 * EXACTLY ONE CoreAPI op through the `CoreClient` (§1.1): a submit is
 * `session.send`, a cancel is `session.cancel`, an approval decision is the
 * one `approvals.resolve` round-trip (§6.1). The renderer never computes a
 * token count, never decides a permission, never compacts, never writes storage.
 */
import { useEffect, useReducer, useRef } from "react";
import type { CoreClient } from "./core-client.js";
import { ChatView, Footer } from "./ChatView.js";
import { Composer } from "./components.js";
import { ApprovalDialog, type ApprovalResponse } from "./ApprovalDialog.js";
import { appendUserTurn, initialState, reduce, type ConversationState } from "./events/reducer.js";

type Action = { kind: "event"; frame: Parameters<typeof reduce>[1] } | { kind: "user"; id: string; text: string };

function rootReducer(state: ConversationState, action: Action): ConversationState {
  if (action.kind === "event") return reduce(state, action.frame);
  return appendUserTurn(state, action.id, action.text);
}

export interface AppProps {
  readonly client: CoreClient;
  readonly sessionId: string;
}

export function App(props: AppProps): React.JSX.Element {
  const { client, sessionId } = props;
  const [state, dispatch] = useReducer(rootReducer, initialState);
  const composerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const unsubscribe = client.subscribe((frame) => dispatch({ kind: "event", frame }));
    return unsubscribe;
  }, [client]);

  const submit = (text: string): void => {
    if (text.startsWith("/")) {
      // A slash command: one op, dispatched not sent as a turn (§4).
      void client.invoke("session.command", [text.slice(1).trim()]);
      return;
    }
    const id = `u-${Date.now()}`;
    dispatch({ kind: "user", id, text });
    // Exactly one CoreAPI op per action (§1.1).
    void client.invoke("session.send", [sessionId, { input: text }]);
  };

  const decide = (response: ApprovalResponse): void => {
    void client.resolveApproval(response);
  };

  return (
    <div className="voidrift-window">
      {state.lockdown ? (
        <div role="status" data-banner="lockdown">
          {state.lockdown}
        </div>
      ) : null}
      <ChatView state={state} />
      {state.pending ? <ApprovalDialog approval={state.pending} onDecision={decide} returnFocusRef={composerRef} /> : null}
      <Composer onSubmit={submit} disabled={state.pending !== null} />
      <Footer state={state} sessionId={sessionId} />
    </div>
  );
}
