// Nudge the agent into the mate-artifact-finish workflow after a Bash command
// visibly archived an OpenSpec change. Stateless PostToolUse hook: never denies
// or blocks; emits additionalContext only on apparent success.
import type { HookEnv } from "./validate-artifact-path";

export interface NudgeOutcome {
  exitCode: number;
  stdout: string;
}

const ARCHIVE_PATH_PATTERN =
  /(?:^|[\s/"'`,(])openspec\/changes\/archive\/(\d{4}-\d{2}-\d{2}-[^/\s"'`,)]+)/;

// The nudge only applies when the openspec capability is enabled and OpenSpec
// git auto mode is on; the plugin registers the hook unconditionally, so the
// gate is evaluated here from launch-injected environment before any parsing.
export function isGateEnabled(env: HookEnv): boolean {
  return env.MATE_OPENSPEC_ENABLED === "1" && env.MATE_GIT_AUTO_MODE === "1";
}

export function shellSplit(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaping = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = command[index + 1] || "";
      if (next === "\\" || /\s/.test(next) || next === "'" || next === '"') {
        escaping = true;
        continue;
      }
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    const next = command[index + 1] || "";
    const previous = command[index - 1] || "";
    const isControlOperator =
      !quote &&
      (char === ";" ||
        char === "|" ||
        (char === "&" && next !== ">" && previous !== ">" && previous !== "<"));
    if (isControlOperator) {
      if (current) parts.push(current);
      current = "";
      if ((char === "|" || char === "&") && next === char) {
        parts.push(char + next);
        index += 1;
      } else {
        parts.push(char);
      }
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function extractChangeFromPath(value: string): string | null {
  const match = value.replaceAll("\\", "/").match(ARCHIVE_PATH_PATTERN);
  return match ? match[1].replace(/^\d{4}-\d{2}-\d{2}-/, "") : null;
}

// Shell syntax tokens are never change-name positionals: separators end the
// archive invocation, redirections are skipped (a bare operator also consumes
// its target token).
const SEPARATOR_PATTERN = /^(\|\|?|&&?|;)$/;
const REDIRECTION_PATTERN = /^(\d*(>>?|<)|&>>?)/;
const BARE_REDIRECTION_PATTERN = /^(\d*(>>?|<)|&>>?)$/;

export function extractArchiveCommand(command: string): string | null {
  const parts = shellSplit(command);
  const index = parts.findIndex(
    (part, position) =>
      part === "archive" &&
      position > 0 &&
      (parts[position - 1] === "openspec" || parts[position - 1].endsWith("/openspec")),
  );
  if (index < 0) return null;
  for (let position = index + 1; position < parts.length; position += 1) {
    const part = parts[position];
    if (!part || part === "--") continue;
    if (SEPARATOR_PATTERN.test(part)) return null;
    if (REDIRECTION_PATTERN.test(part)) {
      if (BARE_REDIRECTION_PATTERN.test(part)) position += 1;
      continue;
    }
    if (part.startsWith("-")) {
      if (part === "--store") position += 1;
      continue;
    }
    return part;
  }
  return null;
}

const MOVE_COMMANDS = new Set([
  "mv",
  "move",
  "move-item",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

function isPython(part: string): boolean {
  return /^python(?:\d(?:\.\d+)*)?(?:\.exe)?$/i.test(part.split(/[\\/]/).pop() || part);
}

export function extractMoveCommand(command: string): string | null {
  const parts = shellSplit(command);
  for (let index = 0; index < parts.length; index += 1) {
    if (MOVE_COMMANDS.has(parts[index].toLowerCase())) {
      for (const part of parts.slice(index + 1)) {
        const change = extractChangeFromPath(part);
        if (change) return change;
      }
    }
    if (isPython(parts[index]) && /(?:shutil\.move|os\.rename|\.rename\s*\()/.test(command)) {
      return extractChangeFromPath(command);
    }
  }
  return null;
}

// Nudge only on apparent success: stay silent on a clear failure indication,
// nudge when success is indicated or indeterminate.
export function isClearFailure(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const value = response as Record<string, unknown>;
  if (value.success === false || value.is_error === true) return true;
  if (typeof value.error === "string" && value.error) return true;
  if (value.interrupted === true) return true;
  const exitCode = value.exit_code ?? value.exitCode;
  return typeof exitCode === "number" && exitCode !== 0;
}

export function evaluate(payload: unknown, env: HookEnv): NudgeOutcome {
  const silent: NudgeOutcome = { exitCode: 0, stdout: "" };
  if (!isGateEnabled(env)) return silent;

  const input = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (input.hook_event_name !== "PostToolUse" || input.tool_name !== "Bash") return silent;

  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : {};
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  const change = extractArchiveCommand(command) || extractMoveCommand(command);
  if (!change) return silent;
  if (isClearFailure(input.tool_response)) return silent;

  const context =
    `OpenSpec change ${change} was just archived. Invoke the mate-artifact-finish ` +
    `skill, then run \`mate artifact finish "${change}" --json\` to complete the ` +
    "finish workflow (commit, tag, and push).";
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context,
      },
    }),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Plugin-shim entry. The gate check precedes stdin parsing so a disabled gate
// costs one env read.
export async function run(): Promise<number> {
  if (!isGateEnabled(process.env)) return 0;

  let payload: unknown = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    payload = {};
  }
  const outcome = evaluate(payload, process.env);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  return outcome.exitCode;
}
