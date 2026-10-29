import { FRAMEWORK_NAME } from "../../../framework";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { absoluteAsWritten, canonicalPath } from "../../../runtime/physical-path";
import {
  SESSION_CONTEXT_PROTOCOL,
  sessionContextFor,
  sessionContextReply,
  type SessionContextResult,
} from "../../../runtime/session-resolution";
import { writeJsonStdout } from "../../write-json-stdout";

export interface SessionContextArgs {
  repo: string;
  json: boolean;
}

const SESSION_CONTEXT_USAGE = `Usage: ${FRAMEWORK_NAME} session context --repo <dir> [--json]`;

export function parseSessionContextArgs(
  argv: string[],
  cwd: string = process.cwd(),
): SessionContextArgs | { error: string } {
  const args: SessionContextArgs = { repo: cwd, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s) : [arg];
    if (flag === "--json") {
      args.json = true;
    } else if (flag === "--repo") {
      const repo = inline ?? argv[++index];
      if (!repo || (inline === undefined && repo.startsWith("--"))) {
        return { error: "--repo requires a directory" };
      }
      /** `link/..` resolves beside the link's target, as the OS does. */
      args.repo = canonicalPath(absoluteAsWritten(repo, cwd));
    } else {
      return { error: `unknown session context option: ${arg}` };
    }
  }
  return args;
}

export const sessionContextCommandDeps = {
  configStore: (): GlobalConfigStore => new GlobalConfigStore(),
};

function writeJsonError(code: "usage" | "internal", message: string): Promise<void> {
  return writeJsonStdout(
    { protocol: SESSION_CONTEXT_PROTOCOL, error: { code, message } },
    { space: 0 },
  );
}

function printHuman(result: SessionContextResult): void {
  if (!result.ok) {
    console.error(`${FRAMEWORK_NAME}: ${result.error.message} (${result.error.code})`);
    return;
  }
  const { context } = result;
  console.log(`companion: ${context.companionPath}`);
  console.log(`repository: ${context.repositoryId} (${context.repositoryPath})`);
}

/**
 * `mate session context`: the companion and policy Mate resolves for a folder,
 * for a Claude plugin in a plain session. Under `--json`, stdout holds exactly
 * one JSON object, on success and on failure.
 */
export async function runSessionContextCommand(
  argv: string[],
  cwd: string = process.cwd(),
): Promise<SessionContextResult | null> {
  const parsed = parseSessionContextArgs(argv, cwd);
  if ("error" in parsed) {
    if (argv.includes("--json")) await writeJsonError("usage", parsed.error);
    console.error(`${FRAMEWORK_NAME}: ${parsed.error}`);
    console.error(SESSION_CONTEXT_USAGE);
    process.exitCode = 1;
    return null;
  }

  let result: SessionContextResult;
  try {
    result = sessionContextFor(parsed.repo, {
      globalConfigPath: sessionContextCommandDeps.configStore().configPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) await writeJsonError("internal", message);
    console.error(`${FRAMEWORK_NAME}: session context failed: ${message}`);
    process.exitCode = 1;
    return null;
  }
  if (parsed.json) {
    await writeJsonStdout(sessionContextReply(result), { space: 0 });
    if (!result.ok) console.error(`${FRAMEWORK_NAME}: ${result.error.message}`);
  } else {
    printHuman(result);
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}
