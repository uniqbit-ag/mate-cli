/** @jsxImportSource @opentui/solid */
/* oxlint-disable react/no-unknown-property, react/react-in-jsx-scope, react/jsx-key, react-doctor/jsx-key */
/**
 * OpenCode V2 TUI plugin module (`{ id, setup }`), OpenCode 2.x only.
 * Solid JSX, not React: `key` is not a reconciliation prop here and `TextProps`
 * does not accept it, so the jsx-key rules cannot be satisfied — only suppressed.
 * Static arrays render through `.map`; a reactive one would need `<For>`.
 */
import { mateVersion } from "../runtime/install";
import { readContext } from "./companion-policy";

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
  };
};

export type MateSlotClaim = {
  prepend?: "home.footer";
  append?: "sidebar.content";
  render: () => unknown;
};

export type MateTuiPluginModule = {
  id: string;
  setup(api: MateTuiApi): void | Promise<void>;
};

const MIDNIGHT_PURPLE_BRIGHT = "#c084fc";
const MATE_VERSION = process.env.MATE_VERSION ?? mateVersion();

function SessionContext({ api, sidebar = false }: { api: MateTuiApi; sidebar?: boolean }) {
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
      <text fg={MIDNIGHT_PURPLE_BRIGHT}>mate v{MATE_VERSION}</text>
      <text fg={text.muted}>repo: {context.repositoryPath}</text>
      <text fg={text.muted}>mate: {context.companionPath}</text>
      {context.stalenessLines.map((note) => (
        <text fg={warning}>{note}</text>
      ))}
    </box>
  );
}

function setup(api: MateTuiApi): void {
  const context = readContext();
  if (!context.companionPath || !context.repositoryPath) {
    return;
  }

  api.ui.slot({ prepend: "home.footer", render: () => <SessionContext api={api} /> });
  api.ui.slot({ append: "sidebar.content", render: () => <SessionContext api={api} sidebar /> });
}

const plugin: MateTuiPluginModule = {
  id: "mate-companion-tui",
  setup,
};

export default plugin;
