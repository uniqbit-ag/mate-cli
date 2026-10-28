// Claude Code adapter of the Tool Guard (`runtime/tool-guard.ts`); verdicts are
// the guard's. Name kept for the plugin hook shim and existing wraps.
import os from "node:os";
import path from "node:path";

import { readCompanionRuntimeContext } from "../runtime/env";
import {
  checkToolCall,
  contentText,
  guardFailureMessage,
  pathText,
  singleWrite,
  type GuardedToolCall,
} from "../runtime/tool-guard";
import type { HookEnv } from "./hook-io";

export interface HookOutcome {
  exitCode: number;
  stderr: string;
}

/**
 * Claude Code's own config/state directory: Agent Runtime state, never Mate
 * artifacts. Not normalised: `link/..` would name another folder than Claude Code's.
 */
function claudeConfigRoot(env: HookEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured) return configured;
  return `${env.HOME || os.homedir()}${path.sep}.claude`;
}

/** Claude tool payloads in the Tool Guard's shape; null for a tool it does not guard. */
function claudeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): GuardedToolCall | null {
  switch (toolName) {
    case "Read":
      return { kind: "read", paths: [pathText(toolInput.file_path)] };
    case "Write":
      return singleWrite(toolInput.file_path, contentText(toolInput.content), "create");
    case "Edit":
      return singleWrite(toolInput.file_path, contentText(toolInput.new_string), "edit");
    case "MultiEdit": {
      const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
      const content = edits
        .map((edit) => (edit && typeof edit === "object" ? contentText(edit.new_string) : ""))
        .join("\n");
      return singleWrite(toolInput.file_path, content, "edit");
    }
    case "NotebookEdit":
      return singleWrite(toolInput.notebook_path, contentText(toolInput.new_source), "edit");
    case "Bash":
      return { kind: "shell", command: pathText(toolInput.command) };
    case "Grep":
      return {
        kind: "search",
        paths: [pathText(toolInput.path)],
        globs: [pathText(toolInput.glob)],
      };
    default:
      return null;
  }
}

/**
 * Fails open only when no Mate context resolves from either source; in a
 * wrapped Working Repository the guard runs without a launch. Otherwise errors
 * fail closed as exit 2; an uncaught one (exit 1) would let the call run.
 */
export async function evaluate(
  payload: unknown,
  env: HookEnv,
  cwd: string = process.cwd(),
): Promise<HookOutcome> {
  try {
    return await judge(payload, env, cwd);
  } catch (error) {
    return { exitCode: 2, stderr: `${guardFailureMessage(error)}\n` };
  }
}

async function judge(payload: unknown, env: HookEnv, cwd: string): Promise<HookOutcome> {
  const allow: HookOutcome = { exitCode: 0, stderr: "" };

  const resolved = readCompanionRuntimeContext(env, cwd);
  if (!resolved.companionPath) return allow;

  const input = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : {};

  const call = claudeToolCall(toolName, toolInput);
  if (!call) return allow;

  const refusal = await checkToolCall(call, {
    companionPath: resolved.companionPath,
    repositoryPath: resolved.repositoryPath,
    workingDirectory: cwd,
    runtimeStateRoots: [claudeConfigRoot(env)],
    env,
  });
  return refusal ? { exitCode: 2, stderr: `${refusal.message}\n` } : allow;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Plugin-shim entry. Non-JSON input names no tool, so it is allowed; Claude
 * Code always sends JSON. Any later error fails closed.
 */
export async function run(): Promise<number> {
  let payload: unknown = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    payload = {};
  }
  let outcome: HookOutcome;
  try {
    outcome = await evaluate(payload, process.env);
  } catch (error) {
    outcome = { exitCode: 2, stderr: `${guardFailureMessage(error)}\n` };
  }
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  return outcome.exitCode;
}
