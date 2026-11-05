/**
 * Keeps Claude sessions an editor plugin started current in the Mate session
 * registry, from Claude's own hook events. Any other session writes nothing.
 */
import {
  addSession,
  endSession,
  isRegistered,
  patchSession,
  refreshSession,
  startedByEditor,
  type RegisteredSession,
  type SessionInput,
  type WriteOptions,
} from "../runtime/session-registry";
import { currentBranch } from "../runtime/current-branch";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import { resolveProjection } from "../runtime/projection";
import { readWrapStateSync } from "../runtime/wrap-state";
import { hookOutcome, runHook, type HookCall, type HookEnv, type HookOutcome } from "./hook-io";

export interface SessionRegisterDeps {
  register: (input: SessionInput) => Promise<unknown>;
  /** Updates a registered session; writes nothing for any other. */
  refresh: (input: SessionInput) => Promise<unknown>;
  registered: (id: string) => Promise<boolean>;
  end: (id: string) => Promise<unknown>;
  patch: (id: string, patch: Partial<RegisteredSession>) => Promise<unknown>;
  branch: (cwd: string) => Promise<string | null>;
  /** True when the Working Repository at `dir` is wrapped for Claude, so the wrap's hook copy runs. */
  wrappedForClaude: (dir: string) => boolean;
  now: () => Date;
}

/** Hooks skip a write they cannot lock within 2 s; the next event registers again. */
const HOOK_WRITE: WriteOptions = { lock: { waitMs: 2000 } };

export const sessionRegisterDeps: SessionRegisterDeps = {
  register: (input) => addSession(input, HOOK_WRITE),
  refresh: (input) => refreshSession(input, HOOK_WRITE),
  registered: (id) => isRegistered(id, HOOK_WRITE),
  end: (id) => endSession(id, HOOK_WRITE),
  patch: (id, patch) => patchSession(id, patch, HOOK_WRITE),
  branch: currentBranch,
  wrappedForClaude: (dir) => {
    const projection = resolveProjection(dir);
    return !!projection && readWrapStateSync(projection.repoRoot).runtimes.has("claude");
  },
  now: () => new Date(),
};

interface ClaudeHookInput {
  session_id?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pidOf(env: HookEnv): number | undefined {
  const pid = Number(env.CLAUDE_PID);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Registers the session of a `SessionStart` event when an editor plugin started
 * it, else refreshes it if registered (a resume). Never throws: a registry
 * failure must not touch the session.
 */
export async function registerClaudeSession(
  env: HookEnv,
  cwd: string,
  input: unknown,
  deps: SessionRegisterDeps = sessionRegisterDeps,
): Promise<void> {
  const event = (input ?? {}) as ClaudeHookInput;
  const id = stringField(event.session_id);
  if (!id) return;
  const dir = stringField(event.cwd) ?? cwd;
  try {
    const editor = startedByEditor(env);
    // Any other session costs one registry read, no Git call.
    if (!editor && !(await deps.registered(id))) return;
    const branch = await deps.branch(dir).catch(() => null);
    const transcript = stringField(event.transcript_path);
    const pid = pidOf(env);
    const entry: SessionInput = {
      id,
      runtime: "claude",
      cwd: dir,
      origin: "editor",
      ...(pid !== undefined ? { pid } : {}),
      ...(branch ? { branch } : {}),
      ...(transcript ? { transcript } : {}),
    };
    await (editor ? deps.register(entry) : deps.refresh(entry));
  } catch {
    /* best-effort */
  }
}

/**
 * Legacy rule: wraps before `--projected` registered this copy bare, and only
 * this hook re-wraps them. So a bare copy counts as the wrap's unless
 * `CLAUDE_PLUGIN_ROOT`, set for plugin hooks only, marks it as the plugin's.
 * Lives here, not in `session-prepare`, so the recording hooks load light.
 */
export function isWrapCopy({ argv, env }: Pick<HookCall, "argv" | "env">): boolean {
  return argv.includes(PROJECTED_FLAG) || !env.CLAUDE_PLUGIN_ROOT;
}

/**
 * Which hook copy registers: the wrap's always; the plugin's only where no wrap
 * copy runs, i.e. a Mate launch in a repository not wrapped for Claude.
 */
export function registersHere(
  wrapCopy: boolean,
  dir: string,
  deps: Pick<SessionRegisterDeps, "wrappedForClaude"> = sessionRegisterDeps,
): boolean {
  if (wrapCopy) return true;
  try {
    return !deps.wrappedForClaude(dir);
  } catch {
    return true;
  }
}

/**
 * Applies `write` to the event's session when this hook copy records; always
 * an empty outcome, and a failed write is dropped. The registry read comes
 * first: most sessions are not registered, and the wrap check reads files.
 */
async function recordForSession(
  call: HookCall,
  wrapCopy: boolean,
  deps: SessionRegisterDeps,
  write: (id: string) => Promise<unknown>,
): Promise<HookOutcome> {
  const event = (call.input ?? {}) as ClaudeHookInput;
  const id = stringField(event.session_id);
  const dir = stringField(event.cwd) ?? call.cwd;
  if (!id || !(await deps.registered(id).catch(() => false))) return hookOutcome(null);
  if (registersHere(wrapCopy, dir, deps)) await write(id).catch(() => {});
  return hookOutcome(null);
}

/** `SessionEnd`: records `endedAt` for a registered session. */
export function runSessionEndHook(
  call: HookCall,
  wrapCopy: boolean,
  deps: SessionRegisterDeps = sessionRegisterDeps,
): Promise<HookOutcome> {
  return recordForSession(call, wrapCopy, deps, (id) => deps.end(id));
}

/** `Notification`: records when the session asked the user for input. */
export function runNotificationHook(
  call: HookCall,
  wrapCopy: boolean,
  deps: SessionRegisterDeps = sessionRegisterDeps,
): Promise<HookOutcome> {
  return recordForSession(call, wrapCopy, deps, (id) =>
    deps.patch(id, { attentionAt: deps.now().toISOString() }),
  );
}

type RecordingHook = (call: HookCall, wrapCopy: boolean) => Promise<HookOutcome>;

/** Shim entry for a recording hook; exits zero even when reading its input fails. */
function runRecordingHook(
  hook: RecordingHook,
  copyOf: (call: HookCall) => boolean,
  argv: readonly string[],
): Promise<number> {
  return runHook(
    (input) => {
      const call = { env: process.env, cwd: process.cwd(), argv, input };
      return hook(call, copyOf(call));
    },
    () => hookOutcome(null),
  );
}

export function runEnd(
  copyOf: (call: HookCall) => boolean,
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  return runRecordingHook(runSessionEndHook, copyOf, argv);
}

export function runNotification(
  copyOf: (call: HookCall) => boolean,
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  return runRecordingHook(runNotificationHook, copyOf, argv);
}
