/** @jsxImportSource @opentui/solid */
/* oxlint-disable react/no-unknown-property, react/react-in-jsx-scope, react/jsx-key, react-doctor/jsx-key */
/**
 * OpenCode V2 TUI plugin module (`{ id, setup }`), OpenCode 2.x only.
 * Solid JSX, not React: `key` is not a reconciliation prop here and `TextProps`
 * does not accept it, so the jsx-key rules cannot be satisfied — only suppressed.
 * Arrays render through `.map`: Solid re-runs it whole on a store change, fine for a few lines.
 */
import { BRAND_ACCENT } from "../brand/palette";
import { mateVersion } from "../runtime/install";
import { readContext, readStalenessLines } from "./companion-policy";

/** Minimal structural slice of the OpenCode V2 TUI API; the published SDK ships no V2 TUI types. */
export type MateTuiApi = {
  /** Host getter: returns the current theme tokens on every read. */
  readonly theme: {
    text: {
      muted: string;
      feedback?: { warning?: { base: string } };
    };
  };
  ui: {
    slot(claim: MateSlotClaim): () => void;
    toast: { show(options: { title?: string; message: string; variant?: "warning" }): void };
  };
  storage: {
    /** A host Solid store: reads inside a render are reactive. */
    memory<Value extends object>(
      key: string,
      options: { readonly initial: Value },
    ): readonly [Value, (mutation: (draft: Value) => void) => void];
  };
};

export type MateSlotClaim = {
  prepend?: "home.footer";
  append?: "sidebar.content";
  render: () => unknown;
};

export type MateTuiPluginModule = {
  id: string;
  setup(api: MateTuiApi): void | (() => void) | Promise<void | (() => void)>;
};

/** A background sync finishes after the first render; the lines must follow it. */
export const STALENESS_POLL_MS = 5_000;

type SessionNotes = { lines: string[] };

/** The `mate v<version>` line uses the brand accent, which reads on light and dark themes alike. */
export const MATE_VERSION_COLOR = BRAND_ACCENT;
const MATE_VERSION = process.env.MATE_VERSION ?? mateVersion();

function SessionContext({
  api,
  notes,
  sidebar = false,
}: {
  api: MateTuiApi;
  notes: SessionNotes;
  sidebar?: boolean;
}) {
  const context = readContext();
  const text = api.theme.text;
  const warning = text.feedback?.warning?.base ?? text.muted;

  return (
    <box
      width="100%"
      maxWidth={sidebar ? undefined : 75}
      paddingLeft={sidebar ? 0 : 2}
      paddingRight={sidebar ? 0 : 2}
      paddingBottom={sidebar ? 1 : 0}
      flexShrink={0}
    >
      <text fg={MATE_VERSION_COLOR}>mate v{MATE_VERSION}</text>
      <text fg={text.muted}>repo: {context.repositoryPath}</text>
      <text fg={text.muted}>mate: {context.companionPath}</text>
      {notes.lines.map((note) => (
        <text fg={warning}>{note}</text>
      ))}
    </box>
  );
}

/** Polls the session lines; a line that appears after startup is also raised as a toast. */
function setup(api: MateTuiApi): (() => void) | undefined {
  const context = readContext();
  if (!context.companionPath || !context.repositoryPath) {
    return undefined;
  }

  const [notes, setNotes] = api.storage.memory<SessionNotes>("mate-session-notes", {
    initial: { lines: context.stalenessLines },
  });
  setNotes((draft) => {
    draft.lines = context.stalenessLines;
  });
  const timer = setInterval(() => {
    const lines = readStalenessLines();
    if (lines.join("\n") === notes.lines.join("\n")) return;
    const shown = new Set(notes.lines);
    const added = lines.filter((line) => !shown.has(line));
    setNotes((draft) => {
      draft.lines = lines;
    });
    for (const message of added) api.ui.toast.show({ title: "mate", message, variant: "warning" });
  }, STALENESS_POLL_MS);
  timer.unref?.();

  api.ui.slot({
    prepend: "home.footer",
    render: () => <SessionContext api={api} notes={notes} />,
  });
  api.ui.slot({
    append: "sidebar.content",
    render: () => <SessionContext api={api} notes={notes} sidebar />,
  });
  return () => clearInterval(timer);
}

const plugin: MateTuiPluginModule = {
  id: "mate-companion-tui",
  setup,
};

export default plugin;
