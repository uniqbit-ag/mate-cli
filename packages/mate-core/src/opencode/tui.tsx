/** @jsxImportSource @opentui/solid */
/* oxlint-disable react/no-unknown-property, react/react-in-jsx-scope */
import fs from "node:fs";
import path from "node:path";

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";

import { resolveOpenCodeActivation } from "./activation";
import { contextFromRuntime, type CompanionContext } from "./companion-policy";

const MIDNIGHT_PURPLE_BRIGHT = "#c084fc";
const NARROW_TERMINAL_WIDTH = 80;

/** Launch env wins (deprecated shims); plain starts read the packaged version. */
function packageVersion(): string {
  if (process.env.MATE_VERSION) return process.env.MATE_VERSION;
  try {
    const raw = fs.readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const MATE_VERSION = packageVersion();

function SessionContext({
  api,
  context,
  compact = false,
  sidebar = false,
}: {
  api: TuiPluginApi;
  context: CompanionContext;
  compact?: boolean;
  sidebar?: boolean;
}) {
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

const AMBER_WARNING = "#f59e0b";

/** Startup notice when several trusted companions are linked and none is pinned. */
function AmbiguousNotice({ api, candidates }: { api: TuiPluginApi; candidates: string[] }) {
  const theme = api.theme.current;

  return (
    <box width="100%" maxWidth={75} paddingTop={2} paddingBottom={1} flexShrink={0}>
      <text fg={AMBER_WARNING}>mate: multiple companions linked — none pinned, none active</text>
      <text fg={theme.textMuted}>
        {candidates.map((candidate) => `- ${path.basename(candidate)} (${candidate})`).join("\n")}
      </text>
      <text fg={theme.textMuted}>
        run `mate companion select {"<id>"}` — active from your next message
      </text>
    </box>
  );
}

function registerActiveSlots(api: TuiPluginApi, context: CompanionContext): void {
  api.slots.register({
    order: 0,
    slots: {
      home_bottom() {
        return <SessionContext api={api} context={context} />;
      },
      sidebar_content() {
        return <SessionContext api={api} context={context} sidebar />;
      },
      app_bottom() {
        if (api.renderer.width >= NARROW_TERMINAL_WIDTH || api.route.current.name !== "session") {
          return null;
        }

        return <SessionContext api={api} context={context} compact />;
      },
    },
  });
}

const tui: TuiPlugin = async (api) => {
  const directory = api.state.path.directory || process.cwd();
  const activation = await resolveOpenCodeActivation(directory);
  if (activation.status !== "ambiguous" && activation.status !== "active") {
    return;
  }

  let activePath: string | null = null;
  if (activation.status === "ambiguous") {
    api.slots.register({
      order: 0,
      slots: {
        home_bottom() {
          return <AmbiguousNotice api={api} candidates={activation.candidates} />;
        },
      },
    });
  } else {
    activePath = activation.context.companionPath;
    registerActiveSlots(api, contextFromRuntime(activation.context));
  }

  // The companion plugin disposes the server instance when the pin lands or
  // changes; the TUI refetches its state on that event, and this swaps the
  // banner to the newly active companion (latest slot registration wins).
  api.event.on("server.instance.disposed", (event) => {
    if (path.resolve(event.properties.directory) !== path.resolve(directory)) return;
    void resolveOpenCodeActivation(directory).then((next) => {
      if (next.status !== "active") return;
      if (next.context.companionPath === activePath) return;
      activePath = next.context.companionPath;
      registerActiveSlots(api, contextFromRuntime(next.context));
    });
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id: "mate-companion-tui",
  tui,
};

export default plugin;
