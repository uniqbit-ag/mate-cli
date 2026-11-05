import { FRAMEWORK_NAME } from "../../../framework";
import {
  addSession,
  removeSession,
  SessionRegistryError,
  sessionRegistryPath,
} from "../../../runtime/session-registry";
import { listSessionsWithState, type SessionStateDeps } from "../../../lib/session-state";
import { stopSession, type SessionStopDeps } from "../../../lib/session-stop";
import { writeJsonStdout } from "../../write-json-stdout";

/**
 * `mate session add|list|remove|stop`: Machine Caller contract for editor plugins.
 * Always JSON on stdout; errors on stderr with a non-zero exit.
 */

const USAGE = [
  `Usage: ${FRAMEWORK_NAME} session add --runtime <claude|opencode> --id <id> --cwd <dir> [--origin <editor|managed|unmanaged>] --json`,
  `       ${FRAMEWORK_NAME} session list --json`,
  `       ${FRAMEWORK_NAME} session remove <id> --json`,
  `       ${FRAMEWORK_NAME} session stop <id> --json`,
].join("\n");

function fail(message: string, usage = false): void {
  console.error(`${FRAMEWORK_NAME}: ${message}`);
  if (usage) console.error(USAGE);
  process.exitCode = 1;
}

interface ParsedArgs {
  flags: Record<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[], valueFlags: string[]): ParsedArgs | { error: string } {
  const parsed: ParsedArgs = { flags: {}, positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s) : [arg];
    if (flag === "--json") continue;
    const name = flag!.slice(2);
    if (!valueFlags.includes(name)) return { error: `unknown option: ${arg}` };
    const value = inline ?? argv[++index];
    if (!value) return { error: `${flag} requires a value` };
    parsed.flags[name] = value;
  }
  return parsed;
}

export async function runSessionRegistryCommand(
  subcommand: "add" | "list" | "remove" | "stop",
  argv: string[],
  file: string = sessionRegistryPath(),
  stateDeps: SessionStateDeps = {},
  stopDeps: SessionStopDeps = {},
): Promise<void> {
  const parsed = parseArgs(argv, subcommand === "add" ? ["runtime", "id", "cwd", "origin"] : []);
  if ("error" in parsed) return fail(parsed.error, true);
  try {
    if (subcommand === "add") {
      const { runtime, id, cwd, origin } = parsed.flags;
      if (!runtime || !id || !cwd || parsed.positionals.length > 0) {
        return fail("session add needs --runtime, --id, and --cwd", true);
      }
      await writeJsonStdout(await addSession({ runtime, id, cwd, origin }, { file }));
      return;
    }
    if (subcommand === "list") {
      if (parsed.positionals.length > 0) return fail("session list takes no arguments", true);
      await writeJsonStdout(await listSessionsWithState({ file, ...stateDeps }));
      return;
    }
    if (parsed.positionals.length !== 1) {
      return fail(`session ${subcommand} needs one session id`, true);
    }
    const id = parsed.positionals[0]!;
    if (subcommand === "stop") {
      await writeJsonStdout(await stopSession(id, { file, ...stopDeps }));
      return;
    }
    await writeJsonStdout(await removeSession(id, file));
  } catch (error) {
    if (error instanceof SessionRegistryError) return fail(error.message);
    throw error;
  }
}
