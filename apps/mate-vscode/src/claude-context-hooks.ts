import fs from "node:fs/promises";
import path from "node:path";

const CLAUDE_SETTINGS_PATH = path.join(".claude", "settings.local.json");
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit"] as const;
const MANAGED_MARKER = "workspace resolve-hook --event";

type HookEvent = (typeof HOOK_EVENTS)[number];
export interface ClaudeHookRunner {
  command: string;
  args?: readonly string[];
}
type ClaudeSettings = Record<string, unknown> & {
  hooks?: Record<string, unknown>;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function executableCommand(executablePath: string): string {
  return /[\s']/u.test(executablePath) ? shellQuote(executablePath) : executablePath;
}

function hookCommand(runner: string | ClaudeHookRunner, event: HookEvent): string {
  if (typeof runner === "string") {
    return `${executableCommand(runner)} workspace resolve-hook --event ${event}`;
  }
  const args = (runner.args ?? []).map(shellQuote).join(" ");
  return `${executableCommand(runner.command)}${args ? ` ${args}` : ""} --event ${event}`;
}

function isManagedHookGroup(value: unknown, event: HookEvent): boolean {
  if (typeof value !== "object" || value === null) return false;
  const hooks = (value as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    if (
      typeof hook !== "object" ||
      hook === null ||
      typeof (hook as { command?: unknown }).command !== "string"
    ) {
      return false;
    }
    const command = (hook as { command: string }).command;
    return (
      command.includes(`${MANAGED_MARKER} ${event}`) ||
      (command.includes("claude-context-hook.cjs") && command.includes(`--event ${event}`))
    );
  });
}

function managedHookGroup(
  runner: string | ClaudeHookRunner,
  event: HookEvent,
): Record<string, unknown> {
  return {
    hooks: [{ type: "command", command: hookCommand(runner, event) }],
  };
}

async function readSettings(settingsPath: string): Promise<ClaudeSettings> {
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Claude Code settings must be a JSON object.");
    }
    return parsed as ClaudeSettings;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

/** Installs only Mate-owned Claude Code hooks while preserving user settings and hooks. */
export async function reconcileClaudeContextHooks(
  workspaceRoot: string,
  runner: string | ClaudeHookRunner = "mate",
): Promise<boolean> {
  const settingsPath = path.join(workspaceRoot, CLAUDE_SETTINGS_PATH);
  const settings = await readSettings(settingsPath);
  const hooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? { ...settings.hooks }
      : {};
  let changed = false;

  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const retained = existing.filter((group) => !isManagedHookGroup(group, event));
    const next = [...retained, managedHookGroup(runner, event)];
    if (JSON.stringify(existing) !== JSON.stringify(next)) changed = true;
    hooks[event] = next;
  }

  if (!changed) return false;
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`, "utf8");
  return true;
}

/** Reconciles the hook pair in every trusted workspace folder. */
export async function reconcileClaudeContextHooksForWorkspaces(
  workspaceRoots: readonly string[],
  runner: string | ClaudeHookRunner = "mate",
): Promise<void> {
  await Promise.all(
    workspaceRoots.map((workspaceRoot) => reconcileClaudeContextHooks(workspaceRoot, runner)),
  );
}
