/**
 * The composer and panel host (desktop-blueprint.md §4, §5).
 */
import { useState } from "react";
import { sanitizeText } from "./sanitize-text.js";

/**
 * A panel declaration as it arrives over the contextBridge — a LOCAL structural
 * mirror of the core's `PanelDeclaration` (core §12.6, panels §5). The desktop
 * renderer must never import `@voidrift/core` (desktop-blueprint §1.2); it keeps
 * this copy and renders the JSON the main process relays unchanged. A committed
 * fixture of the real built-in declarations and a test that renders it catch any
 * drift between this type and the core's shape (desktop-blueprint §7, panels §5).
 */
export interface WirePanelColumn {
  readonly key: string;
  readonly label: string;
  readonly width?: number;
}

export interface WirePanelAction {
  readonly label: string;
  readonly op: string;
}

export interface WirePanelDeclaration {
  readonly title: string;
  readonly columns: readonly WirePanelColumn[];
  readonly source: string | readonly string[];
  readonly actions?: Readonly<Record<string, WirePanelAction>>;
}

/**
 * The multi-line composer (§4). `Enter` submits, `Shift+Enter` inserts a
 * newline. An empty/whitespace-only submit is a NO-OP and never calls
 * `session.send`, so the app never sends input the core would reject as
 * `EMPTY_MESSAGE` (core §2.3). A buffer beginning with `/` is passed through as
 * a slash command for the caller to dispatch.
 */
export interface ComposerProps {
  readonly onSubmit: (text: string) => void;
  readonly disabled?: boolean;
}

export function Composer(props: ComposerProps): React.JSX.Element {
  const [value, setValue] = useState("");

  const submit = (): void => {
    if (value.trim() === "") return; // never send EMPTY_MESSAGE (§4)
    props.onSubmit(value);
    setValue("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      aria-label="Composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor="composer-input">Message</label>
      <textarea
        id="composer-input"
        value={value}
        disabled={props.disabled ?? false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
      />
      <button type="submit" disabled={props.disabled ?? false}>
        Send
      </button>
    </form>
  );
}

/**
 * The PanelHost (§5, §7). Renders a panel from a `WirePanelDeclaration` the main
 * process relayed — pure data: a title, columns, the dotted CoreAPI operation(s)
 * its rows come from, and keyed hotkey actions. The app fetched the rows through
 * the bridge on open and passes them in as `rows`; the declaration holds no rows
 * and no getter (panels §2, §5). The table is semantic and labeled for
 * accessibility; actions are keyed hotkeys.
 */
export interface PanelHostProps {
  readonly name: string;
  readonly definition: WirePanelDeclaration;
  /** The row snapshot the app fetched for this panel's `source` op (§5). */
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly onClose: () => void;
  readonly onAction?: (hotkey: string, item: unknown) => void;
}

export function PanelHost(props: PanelHostProps): React.JSX.Element {
  const { definition } = props;
  const rows = props.rows ?? [];
  const actionEntries = Object.entries(definition.actions ?? {});
  return (
    <section role="dialog" aria-label={definition.title} aria-modal="false">
      <header>
        <h2>{definition.title}</h2>
        <button type="button" onClick={props.onClose} aria-label="Close panel">
          Close
        </button>
      </header>
      <table>
        <caption>{definition.title}</caption>
        <thead>
          <tr>
            {definition.columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
            {actionEntries.length > 0 ? <th scope="col">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {definition.columns.map((c) => (
                <td key={c.key} dir="auto">{sanitizeText(String((row as Record<string, unknown>)[c.key] ?? ""))}</td>
              ))}
              {actionEntries.length > 0 ? (
                <td>
                  {actionEntries.map(([hotkey, action]) => (
                    <button key={hotkey} type="button" onClick={() => props.onAction?.(hotkey, row)}>
                      {action.label} ({hotkey})
                    </button>
                  ))}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
