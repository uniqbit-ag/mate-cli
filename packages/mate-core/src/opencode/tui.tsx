/** @jsxImportSource @opentui/solid */
/* oxlint-disable react/no-unknown-property, react/react-in-jsx-scope */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";

import { readContext } from "./companion-policy";

const MIDNIGHT_PURPLE_BRIGHT = "#c084fc";
const NARROW_TERMINAL_WIDTH = 80;
const MATE_VERSION = process.env.MATE_VERSION ?? "unknown";

function SessionContext({
  api,
  compact = false,
  sidebar = false,
}: {
  api: TuiPluginApi;
  compact?: boolean;
  sidebar?: boolean;
}) {
  const context = readContext(process.env.MATE_ARTIFACT_PATH ?? "");
  const theme = api.theme.current;

  if (compact) {
    return (
      <box width="100%" paddingTop={0} flexShrink={0}>
        <text fg={theme.textMuted}>
          mate v{MATE_VERSION} | repo: {context.repositoryPath} | mate: {context.companionPath}
        </text>
      </box>
    );
  }

  return (
    <box width="100%" maxWidth={75} paddingTop={sidebar ? 0 : 2} paddingBottom={1} flexShrink={0}>
      <text fg={MIDNIGHT_PURPLE_BRIGHT}>mate v{MATE_VERSION}</text>
      <text fg={theme.textMuted}>repo: {context.repositoryPath}</text>
      <text fg={theme.textMuted}>mate: {context.companionPath}</text>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  const context = readContext(process.env.MATE_ARTIFACT_PATH ?? "");
  if (!context.companionPath || !context.repositoryPath) {
    return;
  }

  api.slots.register({
    order: 0,
    slots: {
      home_bottom() {
        return <SessionContext api={api} />;
      },
      sidebar_content() {
        return <SessionContext api={api} sidebar />;
      },
      app_bottom() {
        if (api.renderer.width >= NARROW_TERMINAL_WIDTH || api.route.current.name !== "session") {
          return null;
        }

        return <SessionContext api={api} compact />;
      },
    },
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id: "mate-companion-tui",
  tui,
};

export default plugin;
