/** Delivers the Companion Instructions to a Claude main thread or subagent the launch flags miss. */
import { planClaudeInstructions } from "../runtime/claude-delivery-plan";
import {
  COMPANION_INSTRUCTIONS_BUDGET,
  buildCompanionInstructions,
  companionInstructionsUnavailableLine,
  type CompanionInstructionsInput,
  type InstructionReader,
} from "../runtime/companion-instructions";
import { MATE_ENV, hasLaunchEnvironment } from "../runtime/env";
import { FRAMEWORK_NAME } from "../runtime/framework";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import { resolveProjection } from "../runtime/projection";
import type { SessionKind } from "../runtime/session-kind";
import type { HookEnv } from "./validate-artifact-path";

export interface InstructionHookOutcome {
  exitCode: number;
  stdout: string;
}

export interface InstructionHookPayload {
  hookSpecificOutput?: { hookEventName: InstructionEvent; additionalContext: string };
  systemMessage?: string;
}

export interface InstructionHookInput {
  hook_event_name?: string;
  agent_type?: string;
  source?: string;
  cwd?: string;
}

/**
 * Agents never given a copy, since Claude Code's matchers cannot exclude them:
 * Explore and Plan skip project memory by design, and a fork inherits its
 * parent's context, which already holds the instructions.
 */
const SKIPPED_AGENTS = new Set(["Explore", "Plan", "fork"]);

type InstructionEvent = "SessionStart" | "SubagentStart";

const INPUT_FIELDS = ["hook_event_name", "agent_type", "source", "cwd"] as const;

function normalizeInput(raw: unknown): InstructionHookInput {
  const input: InstructionHookInput = {};
  if (!raw || typeof raw !== "object") return input;
  for (const field of INPUT_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === "string") input[field] = value;
  }
  return input;
}

function sessionKind(env: HookEnv): SessionKind {
  if (!hasLaunchEnvironment(env)) return "unmanaged";
  return env[MATE_ENV.repositoryPath] ? "managed-repo" : "managed-companion";
}

/**
 * A copy runs only because the bundled plugin or a Claude wrap installed it, so
 * a session with no launch environment is planned as Claude-wrapped without
 * reading the Checkout's manifest: a linked worktree runs the main checkout's
 * wrapped settings and has none of its own.
 */
function ownsEvent(event: InstructionEvent, kind: SessionKind, argv: readonly string[]): boolean {
  const owners = planClaudeInstructions(kind, true);
  const projected = argv.includes(PROJECTED_FLAG);
  if (event === "SessionStart") return owners.main === "wrap-session-hook" && projected;
  if (owners.subagents === "plugin-subagent-hook") return !projected;
  if (owners.subagents === "wrap-subagent-hook") return projected;
  return false;
}

/** A launch sets every path, so a managed subagent needs no projection under its cwd. */
function launchReaderInput(env: HookEnv): CompanionInstructionsInput | null {
  const companionPath = env[MATE_ENV.companionPath];
  const id = env[MATE_ENV.repositoryId];
  const repoPath = env[MATE_ENV.repositoryPath];
  const wrapperBinPath = env[MATE_ENV.wrapperBinPath];
  if (!companionPath || !id || !repoPath || !wrapperBinPath) return null;
  return { companionPath, repository: { id, path: repoPath }, wrapperBinPath, runtime: "claude" };
}

function readerInput(
  env: HookEnv,
  kind: SessionKind,
  cwd: string,
): CompanionInstructionsInput | null {
  const launched = launchReaderInput(env);
  if (launched) return launched;
  const projection = resolveProjection(cwd);
  if (!projection) return null;
  /** A linked worktree on a projection copied from the main checkout names itself, not that checkout. */
  const projectedRepoPath = kind === "unmanaged" ? projection.repoRoot : projection.repositoryPath;
  return {
    companionPath: env[MATE_ENV.companionPath] || projection.companionPath,
    repository: {
      id: env[MATE_ENV.repositoryId] || projection.repositoryId,
      path: env[MATE_ENV.repositoryPath] || projectedRepoPath,
    },
    wrapperBinPath: env[MATE_ENV.wrapperBinPath] || projection.wrapperBinPath,
    runtime: "claude",
  };
}

function oversizeMessage(source: string): string {
  const marker = FRAMEWORK_NAME.toUpperCase();
  const budget = COMPANION_INSTRUCTIONS_BUDGET.toLocaleString("en-US");
  return `${FRAMEWORK_NAME}: the ${marker}:COMPANION block in ${source} leaves no room within the ${budget}-character budget, so the instructions exceed it; Claude Code may deliver them as a file preview. Shorten the block.`;
}

function evaluate(
  env: HookEnv,
  cwd: string,
  argv: readonly string[],
  input: InstructionHookInput,
  read: InstructionReader,
): InstructionHookPayload | null {
  const event = input.hook_event_name;
  if (event !== "SessionStart" && event !== "SubagentStart") return null;
  if (event === "SubagentStart" && SKIPPED_AGENTS.has(input.agent_type ?? "")) return null;

  const kind = sessionKind(env);
  if (!ownsEvent(event, kind, argv)) return null;

  const reader = readerInput(env, kind, input.cwd || cwd);
  if (!reader) return null;

  const result = read(reader);
  if (result.kind === "unavailable") {
    const line = companionInstructionsUnavailableLine(result);
    return instructionOutput(event, line, line);
  }
  const warning = result.oversized ? oversizeMessage(result.source) : undefined;
  return instructionOutput(event, result.text, warning);
}

function instructionOutput(
  event: InstructionEvent,
  additionalContext: string,
  systemMessage?: string,
): InstructionHookPayload {
  return {
    hookSpecificOutput: { hookEventName: event, additionalContext },
    ...(systemMessage ? { systemMessage } : {}),
  };
}

function emit(output: InstructionHookPayload | null): InstructionHookOutcome {
  return { exitCode: 0, stdout: output ? `${JSON.stringify(output)}\n` : "" };
}

function failure(error: unknown): InstructionHookPayload {
  const message = error instanceof Error ? error.message : String(error);
  return { systemMessage: `${FRAMEWORK_NAME}: companion instructions hook failed: ${message}` };
}

/**
 * Its own hook output, apart from the policy's: Claude Code caps each output
 * at 10,000 characters. A missing `AGENTS.md` is stated as a fact, never as an
 * instruction to stop: a SessionStart hook cannot block, and a pause would
 * stall a `-p` or SDK session.
 */
export function instructionHookPayload(
  env: HookEnv,
  cwd: string,
  argv: readonly string[],
  input: unknown,
  read: InstructionReader = buildCompanionInstructions,
): InstructionHookPayload | null {
  try {
    return evaluate(env, cwd, argv, normalizeInput(input), read);
  } catch (error) {
    return failure(error);
  }
}

export function buildInstructionHookOutput(
  env: HookEnv,
  cwd: string,
  argv: readonly string[],
  input: unknown,
  read: InstructionReader = buildCompanionInstructions,
): InstructionHookOutcome {
  return emit(instructionHookPayload(env, cwd, argv, input, read));
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** The hook payload on stdin; input that is not JSON reads as no event. */
export async function readHookInput(): Promise<unknown> {
  const raw = await readStdin();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/** Swallows stdout errors: a parent that stopped reading would otherwise end the write in an uncaught `EPIPE`. */
export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let outcome: InstructionHookOutcome;
  try {
    const input = await readHookInput();
    outcome = buildInstructionHookOutput(process.env, process.cwd(), argv, input);
  } catch (error) {
    outcome = emit(failure(error));
  }
  if (outcome.stdout) {
    process.stdout.on("error", () => {});
    process.stdout.write(outcome.stdout);
  }
  return outcome.exitCode;
}
