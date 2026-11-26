import readline from "node:readline/promises";

import { FRAMEWORK_NAME } from "../../framework";
import { FrictionRefusal } from "../../lib/friction/fields";
import { formatCommand } from "../../runtime/command-arg";
import {
  launchAgent,
  TRIAGE_AGENT_NAMES,
  TRIAGE_AGENTS,
  type FoundAgent,
  type TriageAgent,
} from "../../lib/triage/launch";
import {
  prepareTriageSession,
  seedPrompt,
  type TriageSessionFiles,
} from "../../lib/triage/prepare";
import { recordTriageLauncher } from "../../lib/triage/session";
import { currentSession } from "../../runtime/session-id";
import { collectDoctorReport } from "./doctor";

interface TriageArgs {
  target?: string;
  agent: TriageAgent | null;
  launch: boolean;
}

const TRIAGE_USAGE = `Usage: ${FRAMEWORK_NAME} triage ["<fingerprint|report-id>"] [--agent <${TRIAGE_AGENTS.join("|")}>] [--no-launch]`;

function parseTriageArgs(argv: string[]): TriageArgs | { error: string } {
  const args: TriageArgs = { agent: null, launch: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s) : [arg];
    if (flag === "--no-launch" && inline === undefined) {
      args.launch = false;
    } else if (flag === "--agent") {
      const value = inline ?? argv[++index];
      if (!TRIAGE_AGENTS.includes(value as TriageAgent)) {
        return { error: `--agent must be one of: ${TRIAGE_AGENTS.join(", ")}` };
      }
      args.agent = value as TriageAgent;
    } else if (!arg.startsWith("-")) {
      if (arg.trim() === "") return { error: "the Triage Target is empty" };
      if (args.target !== undefined) {
        return { error: `triage takes one Triage Target; got a second: ${arg}` };
      }
      args.target = arg;
    } else {
      return { error: `unknown triage option: ${arg}` };
    }
  }
  return args;
}

export interface TriageDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
  /** Asks which agent to start; null when no terminal can ask. Defaults to a prompt on a TTY stdin. */
  ask?: AskAgent | null;
  collectDoctor?: (cwd: string) => Promise<unknown>;
  launch?: typeof launchAgent;
}

type AskAgent = (choices: TriageAgent[]) => Promise<TriageAgent | null>;

const askAgent: AskAgent = async (choices) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Start which agent? (${choices.join("/")}) `);
    const picked = answer.trim().toLowerCase();
    return choices.find((choice) => choice === picked) ?? null;
  } finally {
    rl.close();
  }
};

async function chooseAgent(
  requested: TriageAgent | null,
  agents: FoundAgent[],
  ask: AskAgent | null,
): Promise<{ found: FoundAgent } | { error: string }> {
  const pick = (id: TriageAgent | null, error: string) => {
    const found = agents.find((agent) => agent.agent === id);
    return found ? { found } : { error };
  };
  if (requested) return pick(requested, `${TRIAGE_AGENT_NAMES[requested]} was not found on PATH.`);
  if (agents.length === 0) {
    return {
      error: `No agent was found: install ${TRIAGE_AGENTS.map((id) => TRIAGE_AGENT_NAMES[id]).join(" or ")}, or start your own agent with the prompt in prompt.md.`,
    };
  }
  if (agents.length === 1) return { found: agents[0]! };
  const flags = agents.map((agent) => `--agent ${agent.agent}`).join(" or ");
  if (!ask) return { error: `Several agents are installed; choose one with ${flags}.` };
  const picked = await ask(agents.map((agent) => agent.agent));
  return pick(picked, `No agent chosen; choose one with ${flags}.`);
}

function printPaths(files: TriageSessionFiles): void {
  console.log(`Triage session: ${files.dir}`);
  console.log(`  context:  ${files.context}`);
  console.log(`  playbook: ${files.playbook}`);
  console.log(`  prompt:   ${files.prompt}`);
}

/**
 * @command mate triage
 * @description Writes a triage session under Mate's home (machine facts, the
 * shipped playbook, a seed prompt and a 30-day friction snapshot) and starts
 * Claude Code or OpenCode in it, directly and not through a Mate launch.
 * Runs before every gate, so it works when Mate itself does not.
 * An optional Triage Target (a fingerprint or Free Report id) focuses the
 * session on that item and chooses the snapshot's companion.
 * `--no-launch` only prints the session paths.
 */
export async function runTriageCommand(argv: string[] = [], deps: TriageDeps = {}): Promise<void> {
  const args = parseTriageArgs(argv);
  if ("error" in args) {
    console.error(`${FRAMEWORK_NAME}: ${args.error}`);
    console.error(TRIAGE_USAGE);
    process.exitCode = 1;
    return;
  }
  const env = deps.env ?? process.env;
  let prepared: Awaited<ReturnType<typeof prepareTriageSession>>;
  try {
    prepared = await prepareTriageSession({
      argv,
      cwd: deps.cwd ?? process.cwd(),
      homeDir: env.HOME,
      now: deps.now ?? new Date(),
      pathValue: env.PATH ?? "",
      env,
      collectDoctor: deps.collectDoctor ?? ((cwd) => collectDoctorReport({ cwd, write: false })),
      target: args.target,
    });
  } catch (error) {
    if (!(error instanceof FrictionRefusal)) throw error;
    console.error(`${FRAMEWORK_NAME}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const { files, agents } = prepared;
  printPaths(files);
  if (!args.launch) return;
  if (currentSession(env)) {
    console.log(
      `No agent started: this is an agent session. Run \`${formatCommand([FRAMEWORK_NAME, "triage", ...argv])}\` in your own terminal.`,
    );
    return;
  }

  const ask = deps.ask === undefined ? (process.stdin.isTTY ? askAgent : null) : deps.ask;
  const choice = await chooseAgent(args.agent, agents, ask);
  if ("error" in choice) {
    console.error(`${FRAMEWORK_NAME}: ${choice.error}`);
    process.exitCode = 1;
    return;
  }
  const release = recordTriageLauncher(files.dir);
  try {
    process.exitCode = await (deps.launch ?? launchAgent)({
      ...choice.found,
      sessionDir: files.dir,
      prompt: seedPrompt(),
    });
  } finally {
    release();
  }
}
