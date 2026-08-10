import path from "node:path";

import type { Config, Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { MateGuidanceFile } from "@uniqbit/mate-core/runtime";

import {
  buildOpenCodeGuidance,
  contextFromRuntime,
  resolveOpenCodeActivation,
  type CompanionContext,
} from "@uniqbit/mate-core/opencode";

type ConfigHook = NonNullable<Hooks["config"]>;

function prependPathEntry(pathValue: string | undefined, entry: string): string {
  const entries = (pathValue ?? "").split(path.delimiter).filter(Boolean);
  return [entry, ...entries.filter((value) => value !== entry)].join(path.delimiter);
}

function materializeCompanionGuidance(
  guidance: string,
  context: CompanionContext,
  wrapperBinPath: string,
): string {
  return guidance
    .replaceAll("$MATE_REPO_PATH", context.repositoryPath)
    .replaceAll("$MATE_ARTIFACT_PATH", context.companionPath)
    .replaceAll("$MATE_WRAPPER_BIN_PATH", wrapperBinPath)
    .replaceAll("$MATE_REPO_ID", context.repositoryId);
}

function buildSystemPrompt(
  context: CompanionContext,
  guidance: MateGuidanceFile,
  wrapperBinPath: string,
): string[] {
  const lines = [materializeCompanionGuidance(guidance.companionGuidance, context, wrapperBinPath)];

  if (guidance.codebaseExplorationGuidance.trim()) {
    lines.push("", guidance.codebaseExplorationGuidance);
  }

  if (context.agentsMd.trim()) {
    lines.push("", `<agents.md>${context.agentsMd.trim()}</agents.md>`);
  }

  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The single static Mate MCP gateway entry. Companion MCP servers are no
 * longer merged into host config; the gateway daemon resolves the repo pin
 * per connection and delivers companion tools as `mate__*` with hot
 * `list_changed` swaps on repin/config edits.
 */
const MATE_GATEWAY_MCP_SERVER_NAME = "mate";

function buildMateGatewayMcpEntry(): Record<string, unknown> {
  return { type: "local", command: ["mate", "mcp", "shim"], enabled: true };
}

/**
 * Watch each `session.idle` for the repo-local pin diverging from the loaded
 * companion (`null` while ambiguous). `mate companion select` writes the pin;
 * disposing the server instance makes the next request rebuild it against the
 * newly resolved companion — the config hook re-runs and loads its skills,
 * MCP servers, and permissions without a user-visible restart (verified
 * against opencode 1.18: POST /instance/dispose re-runs plugin init on the
 * next request).
 */
function reactivationWatcher(
  input: PluginInput,
  loadedCompanionPath: string | null,
): NonNullable<Hooks["event"]> {
  const directory = input.directory ?? process.cwd();
  let reactivating = false;
  return async ({ event }) => {
    if (reactivating || event.type !== "session.idle") return;
    const next = await resolveOpenCodeActivation(directory);
    if (next.status !== "active") return;
    if (next.context.companionPath === loadedCompanionPath) return;
    reactivating = true;
    try {
      try {
        await input.client?.tui?.showToast({
          body: {
            message: loadedCompanionPath
              ? "mate: companion switched — reactivating session"
              : "mate: companion pinned — reactivating session",
            variant: "success",
          },
          query: { directory },
        });
      } catch {
        /* headless server or TUI gone — reactivation matters, the toast does not */
      }
      await input.client?.instance?.dispose({ query: { directory } });
    } catch {
      /* dispose failed — allow a later idle to retry */
      reactivating = false;
    }
  };
}

/** Prompt-only hooks used while the companion choice is ambiguous. */
function ambiguityHooks(input: PluginInput, instruction: string): Hooks {
  return {
    "experimental.chat.system.transform": async (_input: any, output: { system: string[] }) => {
      output.system.push(instruction);
    },
    event: reactivationWatcher(input, null),
  };
}

export const CompanionPlugin: Plugin = async (input) => {
  const activation = await resolveOpenCodeActivation(input.directory ?? process.cwd());

  if (activation.status === "inert") return {};
  if (activation.status === "untrusted") {
    process.stderr.write(`${activation.warning}\n`);
    return {};
  }
  if (activation.status === "ambiguous") {
    return ambiguityHooks(input, activation.instruction);
  }

  const context = contextFromRuntime(activation.context);
  const wrapperBinPath = activation.wrapperBinPath;
  // Built from the resolved companion's live capability configuration —
  // never from a launch-delivered payload.
  const guidance = buildOpenCodeGuidance(activation.config.capabilities ?? []);

  return {
    // Repin/switch support: a changed pin disposes the instance so the next
    // request rebuilds against the newly selected companion.
    event: reactivationWatcher(input, context.companionPath),
    // Inject companion access, skill paths, and MCP servers at load time so
    // sessions started by any entry point carry the full Mate configuration.
    config: (async (cfg: Config) => {
      const permission = (cfg.permission ??= {}) as { external_directory?: unknown };
      const externalDirectory = (permission.external_directory ??= {}) as Record<
        string,
        "allow" | "ask" | "deny" | undefined
      >;
      for (const rule of [context.companionPath, `${context.companionPath}/**`]) {
        externalDirectory[rule] ??= "allow";
      }

      const skills = ((cfg as Record<string, unknown>).skills = isRecord(
        (cfg as Record<string, unknown>).skills,
      )
        ? ((cfg as Record<string, unknown>).skills as Record<string, unknown>)
        : {});
      const skillPaths = Array.isArray(skills.paths) ? (skills.paths as string[]) : [];
      const companionSkillsPath = path.join(context.companionPath, ".agents", "skills");
      if (!skillPaths.includes(companionSkillsPath)) skillPaths.push(companionSkillsPath);
      skills.paths = skillPaths;

      const mcp = ((cfg as Record<string, unknown>).mcp = isRecord(
        (cfg as Record<string, unknown>).mcp,
      )
        ? ((cfg as Record<string, unknown>).mcp as Record<string, unknown>)
        : {});
      mcp[MATE_GATEWAY_MCP_SERVER_NAME] ??= buildMateGatewayMcpEntry();
    }) satisfies ConfigHook,
    tool: {
      companion_paths: tool({
        description: `Return active ${context.frameworkName} working repository and companion framework paths.`,
        args: {},
        async execute() {
          return {
            output: JSON.stringify(
              {
                companionFrameworkPath: context.companionPath,
                wrapperBinPath,
                repositoryPath: context.repositoryPath,
                repositoryId: context.repositoryId,
                policy: JSON.parse(context.policyJson || "{}"),
              },
              null,
              2,
            ),
            metadata: {
              companionPath: context.companionPath,
              wrapperBinPath,
              repositoryPath: context.repositoryPath,
            },
          };
        },
      }),
    },
    "experimental.chat.system.transform": async (_input: any, output: { system: string[] }) => {
      // Collapse the whole system prompt into a single entry. opencode expands
      // each `system[]` element into its own `role:"system"` wire message, and
      // some self-hosted chat templates (e.g. Qwen served via vLLM) reject any
      // system message that is not the very first message. Merging opencode's
      // own parts with the mate companion block guarantees exactly one leading
      // system message.
      const companion = buildSystemPrompt(context, guidance, wrapperBinPath).join("\n");
      const merged = [...output.system, companion]
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join("\n\n");
      output.system.length = 0;
      if (merged.length > 0) {
        output.system.push(merged);
      }
    },
    "experimental.session.compacting": async (_input: any, output: { context: string[] }) => {
      output.context.push(buildSystemPrompt(context, guidance, wrapperBinPath).join("\n"));
    },
    "shell.env": async (_input: any, output: { env: Record<string, string> }) => {
      output.env.MATE_NAME = context.frameworkName;
      output.env.MATE_VERSION = process.env.MATE_VERSION ?? "unknown";
      output.env.MATE_ARTIFACT_PATH = context.companionPath;
      output.env.MATE_WRAPPER_BIN_PATH = wrapperBinPath;
      output.env.MATE_REPO_PATH = context.repositoryPath;
      output.env.MATE_REPO_ID = context.repositoryId;
      output.env.MATE_POLICY_JSON = context.policyJson;
      output.env.MATE_GRAPHIFY_ENABLED = context.graphifyEnabled ? "1" : "0";
      output.env.MATE_GIT_AUTO_MODE = context.gitAutoModeEnabled ? "1" : "0";

      output.env.PATH = prependPathEntry(process.env.PATH, wrapperBinPath);
    },
  };
};

export default CompanionPlugin;
