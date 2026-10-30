/** Delivers the Companion Instructions to a Claude main thread or subagent. */
import { errorMessage } from "../runtime/error-message";
import { planClaudeInstructions } from "../runtime/claude-delivery-plan";
import {
  COMPANION_INSTRUCTIONS_BUDGET,
  buildCompanionInstructions,
  companionInstructionsUnavailableLine,
  type CompanionInstructionsInput,
  type InstructionReader,
} from "../runtime/companion-instructions";
import { FRAMEWORK_NAME } from "../runtime/framework";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import { managedSessionKind, type SessionKind } from "../runtime/session-kind";
import { resolveSession, type ResolvedSession } from "../runtime/session-resolution";
import { hookFolder, hookOutcome, runHook, type HookCall } from "./hook-io";

export interface InstructionHookPayload {
  hookSpecificOutput?: { hookEventName: InstructionEvent; additionalContext: string };
  systemMessage?: string;
}

export interface InstructionHookInput {
  hook_event_name?: string;
  agent_type?: string;
  cwd?: string;
}

/** A hook run, with the shim arguments already read. */
export interface InstructionHookCall extends Omit<HookCall, "argv"> {
  /** The copy a wrap carries, marked `--projected`. */
  projected: boolean;
  /** Where the projection resolves; the event's `cwd` when unset. */
  directory?: string;
}

export interface InstructionHookDeps {
  read?: InstructionReader;
}

/**
 * Agents never given a copy, since Claude Code's matchers cannot exclude them:
 * Explore and Plan skip project memory by design, and a fork inherits its
 * parent's context, which already holds the instructions.
 */
const SKIPPED_AGENTS = new Set(["Explore", "Plan", "fork"]);

type InstructionEvent = "SessionStart" | "SubagentStart";

const INPUT_FIELDS = ["hook_event_name", "agent_type", "cwd"] as const;

function normalizeInput(raw: unknown): InstructionHookInput {
  const input: InstructionHookInput = {};
  if (!raw || typeof raw !== "object") return input;
  for (const field of INPUT_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === "string") input[field] = value;
  }
  return input;
}

function sessionKind(session: ResolvedSession): SessionKind {
  if (session.kind !== "launch") return "unmanaged";
  return managedSessionKind(session.scope === "repository");
}

/**
 * A copy runs only because the bundled plugin or a Claude wrap installed it, so
 * a session with no launch environment is planned as Claude-wrapped without
 * reading the Checkout's manifest: a linked worktree runs the main checkout's
 * wrapped settings and has none of its own.
 */
function ownsEvent(event: InstructionEvent, kind: SessionKind, projected: boolean): boolean {
  const owners = planClaudeInstructions(kind, true);
  if (event === "SessionStart") return owners.main === "wrap-session-hook" && projected;
  if (owners.subagents === "plugin-subagent-hook") return !projected;
  if (owners.subagents === "wrap-subagent-hook") return projected;
  return false;
}

/**
 * A launch sets every path; a partial one is not completed from a projection,
 * which may name another repository. A projection names the Checkout it was
 * found in, so a linked worktree on a projection copied from the main checkout
 * names itself, not that checkout.
 */
function readerInput(session: ResolvedSession): CompanionInstructionsInput | null {
  if (session.kind === "none") return null;
  const wrapperBinPath =
    session.kind === "launch" ? session.wrapperBinPath : session.projection.wrapperBinPath;
  const { companionPath, repositoryId: id, checkoutRoot } = session;
  if (!companionPath || !id || !checkoutRoot || !wrapperBinPath) return null;
  return { companionPath, repository: { id, path: checkoutRoot }, wrapperBinPath };
}

function oversizeMessage(source: string): string {
  const marker = FRAMEWORK_NAME.toUpperCase();
  const budget = COMPANION_INSTRUCTIONS_BUDGET.toLocaleString("en-US");
  return `${FRAMEWORK_NAME}: the ${marker}:COMPANION block in ${source} leaves no room within the ${budget}-character budget, so the instructions exceed it; Claude Code may deliver them as a file preview. Shorten the block.`;
}

function evaluate(
  { env, cwd, projected, directory }: InstructionHookCall,
  input: InstructionHookInput,
  deps: InstructionHookDeps,
): InstructionHookPayload | null {
  const read = deps.read ?? buildCompanionInstructions;
  const event = input.hook_event_name;
  if (event !== "SessionStart" && event !== "SubagentStart") return null;
  if (event === "SubagentStart" && SKIPPED_AGENTS.has(input.agent_type ?? "")) return null;

  const session = resolveSession(env, directory || hookFolder(input, env, cwd));
  if (!ownsEvent(event, sessionKind(session), projected)) return null;

  const reader = readerInput(session);
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

function failure(error: unknown): InstructionHookPayload {
  return {
    systemMessage: `${FRAMEWORK_NAME}: companion instructions hook failed: ${errorMessage(error)}`,
  };
}

/**
 * Its own hook output, apart from the Agent Guidance's: Claude Code caps each
 * output at 10,000 characters. A missing `AGENTS.md` is stated as a fact, never
 * as an instruction to stop: a SessionStart hook cannot block, and a pause
 * would stall a `-p` or SDK session.
 */
export function instructionHookPayload(
  call: InstructionHookCall,
  deps: InstructionHookDeps = {},
): InstructionHookPayload | null {
  try {
    return evaluate(call, normalizeInput(call.input), deps);
  } catch (error) {
    return failure(error);
  }
}

/** Plugin-shim entry; exits zero even when reading its input fails. */
export function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runHook(
    (input) =>
      hookOutcome(
        instructionHookPayload({
          env: process.env,
          cwd: process.cwd(),
          projected: argv.includes(PROJECTED_FLAG),
          input,
        }),
      ),
    (error) => hookOutcome(failure(error)),
  );
}
