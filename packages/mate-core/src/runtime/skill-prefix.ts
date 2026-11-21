/**
 * The skill invocation syntax of the Agent Runtime a command runs under, so a hand-off names a
 * step the way the developer types it there. Claude Code marks its shells with `CLAUDECODE`;
 * OpenCode's carry its session id and Mate's plugin sets `MATE_AGENT_RUNTIME`; Codex's carry
 * `CODEX_THREAD_ID`, Pi's `PI_CODING_AGENT`. Anything else gets `/`, the syntax of Claude Code
 * and Cursor.
 */

const PREFIXES = { claude: "/", opencode: "@", codex: "$", pi: "/skill:" } as const;

export type AgentRuntime = keyof typeof PREFIXES;

/** Set by Mate's runtime plugins in each shell they spawn. */
export const AGENT_RUNTIME_ENV = "MATE_AGENT_RUNTIME";

export function agentRuntime(env: Record<string, string | undefined>): AgentRuntime {
  const declared = env[AGENT_RUNTIME_ENV];
  if (declared && Object.hasOwn(PREFIXES, declared)) return declared as AgentRuntime;
  if (env.CLAUDECODE === "1") return "claude";
  if (env.OPENCODE_SESSION_ID || env.OPENCODE === "1") return "opencode";
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return "codex";
  if (env.PI_CODING_AGENT || env.PI_SESSION_ID) return "pi";
  return "claude";
}

/** A skill invocation and the change it names; `change` is empty when it names none. */
export interface Invocation {
  skill: string;
  change: string;
}

/** `skill [change]` in the runtime's syntax. */
export function formatInvocation(runtime: AgentRuntime, skill: string, change?: string): string {
  return `${PREFIXES[runtime]}${skill}${change ? ` ${change}` : ""}`;
}

const SKILL = "[a-z0-9][a-z0-9-]*";
const CHANGE = "[A-Za-z0-9][A-Za-z0-9._-]*";
/** Any runtime's prefix; `/skill:` before `/`, which it starts with. */
const PREFIX = "(?:/skill:|[/@$])";
/** A prompt that starts with a skill invocation in any runtime's syntax, then a change name. */
const PROMPT = new RegExp(`^\\s*${PREFIX}(${SKILL})\\s+["'\`]?(${CHANGE})`);
/** A numbered skill action of a `## Next steps` section. */
const ACTION = new RegExp(`^\\d+\\.\\s+${PREFIX}(${SKILL})\\s+(${CHANGE})`, "gm");

const CHANGE_WORD = new RegExp(`^${CHANGE}$`);

/** Whether `value` is a change name as an invocation names one: never a flag or shell syntax. */
export function isInvocationChange(value: string): boolean {
  return CHANGE_WORD.test(value);
}

/** The invocation a prompt starts with, in any runtime's syntax, when it names a change. */
export function invokedSkill(prompt: string): Invocation | undefined {
  const match = PROMPT.exec(prompt);
  return match ? { skill: match[1]!, change: match[2]! } : undefined;
}

/** The numbered skill actions of a written section that name a change, in any prefix; quotes dropped. */
export function parseInvocations(text: string): Invocation[] {
  return [...text.replace(/["'`]/g, "").matchAll(ACTION)].map((match) => ({
    skill: match[1]!,
    change: match[2]!,
  }));
}

/**
 * Whether `text` names `skill change` after any runtime's prefix, the change ending its word;
 * with no change, the skill alone, followed by anything.
 */
export function namesInvocation(text: string, { skill, change }: Invocation): boolean {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = change ? `\\s+${escape(change)}` : "";
  return new RegExp(`${PREFIX}${escape(skill)}${tail}(?![\\w-])`).test(text);
}
