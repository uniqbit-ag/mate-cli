import fs from "node:fs";
import path from "node:path";

import { serveAttach } from "../../../lib/factory/attach";
import {
  agentCommand,
  ATTACH_STARTS,
  type AttachStart,
  CLAUDE_SESSION_ID,
  runAttach,
  worksetIntent,
} from "../../../lib/factory/attach-client";
import { brokerHandler, serveBroker, takeAgentCredential } from "../../../lib/factory/broker";
import { attachSocketFor, FACTORY_BROKER_ENV } from "../../../lib/factory/client";
import { CREDENTIAL_FILE, CredentialStore } from "../../../lib/factory/credential-store";
import {
  GIT_CREDENTIAL_FILE,
  GitCredentialStore,
  takeGitStartupToken,
} from "../../../lib/factory/git-credential-store";
import { WorksetRuntime } from "../../../lib/factory/runtime";
import { usage } from "../../usage";

const SERVE_OPTIONS = [
  "socket",
  "docker-host",
  "state-dir",
  "image",
  "user",
  "companions-dir",
] as const;
type ServeOption = (typeof SERVE_OPTIONS)[number];
/** Workset resource limits; each may be left out. */
const SERVE_LIMITS = [
  "max-worksets",
  "idle-minutes",
  "memory",
  "agent-memory",
  "pids",
  "cpus",
] as const;
type ServeLimit = (typeof SERVE_LIMITS)[number];

export interface ServeArgs extends Record<ServeOption, string> {
  maxWorksets?: number;
  idleMinutes?: number;
  memory?: string;
  /** Agent stages' memory limit; `memory` when absent. */
  agentMemory?: string;
  pids?: number;
  cpus?: string;
}

const WHOLE = /^\d+$/;
/** A Docker size: a whole number with an optional `b`, `k`, `m` or `g` unit. */
const DOCKER_SIZE = /^[1-9]\d*[bkmg]?$/i;

function limitValue(name: ServeLimit, value: string): Partial<ServeArgs> | { error: string } {
  switch (name) {
    case "max-worksets":
      return WHOLE.test(value) && Number(value) >= 1
        ? { maxWorksets: Number(value) }
        : { error: "--max-worksets needs a whole number of at least 1" };
    case "idle-minutes":
      return WHOLE.test(value)
        ? { idleMinutes: Number(value) }
        : { error: "--idle-minutes needs a whole number" };
    case "memory":
      return DOCKER_SIZE.test(value)
        ? { memory: value.toLowerCase() }
        : { error: "--memory needs a size such as 4g" };
    case "agent-memory":
      return DOCKER_SIZE.test(value)
        ? { agentMemory: value.toLowerCase() }
        : { error: "--agent-memory needs a size such as 1536m" };
    case "pids":
      return WHOLE.test(value) && Number(value) >= 1
        ? { pids: Number(value) }
        : { error: "--pids needs a whole number of at least 1" };
    case "cpus":
      return /^\d+(\.\d+)?$/.test(value) && Number(value) > 0
        ? { cpus: value }
        : { error: "--cpus needs a number above 0" };
  }
}

export function parseServeArgs(argv: string[]): ServeArgs | { error: string } {
  const values: Partial<Record<ServeOption, string>> = {};
  const limits: Partial<ServeArgs> = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!.replace(/^--/, "");
    const value = argv[index + 1];
    const isLimit = SERVE_LIMITS.includes(name as ServeLimit);
    if (
      !argv[index]!.startsWith("--") ||
      !(isLimit || SERVE_OPTIONS.includes(name as ServeOption))
    ) {
      return { error: `unknown option ${argv[index]}` };
    }
    if (value === undefined || value.startsWith("--")) return { error: `--${name} needs a value` };
    if (isLimit) {
      const parsed = limitValue(name as ServeLimit, value);
      if ("error" in parsed) return parsed;
      Object.assign(limits, parsed);
    } else {
      values[name as ServeOption] = value;
    }
    index++;
  }
  const missing = SERVE_OPTIONS.filter((name) => values[name] === undefined);
  if (missing.length > 0)
    return { error: `missing ${missing.map((name) => `--${name}`).join(", ")}` };
  if (
    limits.memory === undefined &&
    (limits.pids !== undefined || limits.cpus !== undefined || limits.agentMemory !== undefined)
  ) {
    return { error: "--pids, --cpus and --agent-memory go with --memory" };
  }
  return { ...(values as Record<ServeOption, string>), ...limits };
}

/** How often the broker looks for idle Workset containers. */
const IDLE_SWEEP_MS = 60_000;

/** Stops idle Workset containers every {@link IDLE_SWEEP_MS}; a sweep never overlaps the last. */
function startIdleSweep(runtime: WorksetRuntime): ReturnType<typeof setInterval> {
  let sweeping = false;
  return setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    runtime
      .sweepIdle()
      .then((stopped) => {
        for (const id of stopped) process.stderr.write(`mate factory: stopped idle ${id}\n`);
      })
      .catch((error: unknown) => {
        process.stderr.write(`mate factory: idle stop failed: ${(error as Error).message}\n`);
      })
      .finally(() => {
        sweeping = false;
      });
  }, IDLE_SWEEP_MS);
}

/**
 * `mate factory serve`: the factory broker, started as root by the appliance's
 * factory supervisor. Serves until terminated.
 */
export interface AttachArgs {
  id: string;
  session: string;
  start: AttachStart;
  companion: string;
  noGit?: boolean;
  /** For a `resume` start: the factory's Claude session. */
  resumeSession?: string;
}

const ATTACH_VALUES = new Set(["session", "start", "companion", "resume-session"]);

export function parseAttachArgs(argv: string[]): AttachArgs | { error: string } {
  const [id, ...rest] = argv;
  if (!id || id.startsWith("--")) return { error: "name the Workset to attach to" };
  const values: Record<string, string> = {};
  let noGit = false;
  let index = 0;
  while (index < rest.length) {
    const option = rest[index]!;
    if (option === "--no-git") {
      noGit = true;
      index += 1;
      continue;
    }
    const name = option.replace(/^--/, "");
    const value = rest[index + 1];
    if (!option.startsWith("--") || !ATTACH_VALUES.has(name)) {
      return { error: `unknown option ${option}` };
    }
    if (value === undefined) return { error: `--${name} needs a value` };
    values[name] = value;
    index += 2;
  }
  if (!values.session || !values.companion) {
    return { error: "--session and --companion are required" };
  }
  const start = (values.start ?? "continue") as AttachStart;
  if (!ATTACH_STARTS.includes(start)) {
    return { error: `--start must be one of ${ATTACH_STARTS.join(", ")}` };
  }
  const resumeSession = values["resume-session"];
  if ((start === "resume") !== (resumeSession !== undefined)) {
    return { error: "--resume-session goes with --start resume, and only with it" };
  }
  if (resumeSession !== undefined && !CLAUDE_SESSION_ID.test(resumeSession)) {
    return { error: "--resume-session is not a Claude session id" };
  }
  return {
    id,
    session: values.session,
    start,
    companion: values.companion,
    ...(noGit ? { noGit } : {}),
    ...(resumeSession ? { resumeSession } : {}),
  };
}

/** `mate factory attach`: the Workset session's agent, relayed from the broker into this terminal. */
async function runAttachCommand(argv: string[]): Promise<void> {
  const args = parseAttachArgs(argv);
  if ("error" in args) {
    console.error(`mate factory attach: ${args.error}`);
    process.exitCode = 1;
    return;
  }
  const broker = process.env[FACTORY_BROKER_ENV];
  if (!broker) {
    console.error("mate factory attach: factory mode is not enabled (no factory broker)");
    process.exitCode = 1;
    return;
  }
  let intent = "";
  if (args.start === "clarify") {
    try {
      intent = await worksetIntent(args.companion, args.id);
    } catch (error) {
      console.error(`mate factory attach: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = await runAttach(
    attachSocketFor(broker),
    {
      id: args.id,
      session: args.session,
      command: agentCommand(args.start, intent, {
        ...(args.noGit ? { noGit: true } : {}),
        ...(args.resumeSession ? { resumeSession: args.resumeSession } : {}),
      }),
    },
    { input: process.stdin, output: process.stdout, error: process.stderr },
  );
  process.stdin.pause();
}

export async function runFactoryCommand(
  subcommand: string | undefined,
  argv: string[],
): Promise<void> {
  if (subcommand === "attach") {
    await runAttachCommand(argv);
    return;
  }
  if (subcommand !== "serve") {
    console.error(`Unknown factory command: ${subcommand ?? ""}`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const options = parseServeArgs(argv);
  if ("error" in options) {
    console.error(`mate factory serve: ${options.error}`);
    process.exitCode = 1;
    return;
  }
  const credentials = new CredentialStore(
    path.join(options["state-dir"], CREDENTIAL_FILE),
    takeAgentCredential(),
  );
  const gitTokens = new GitCredentialStore(
    path.join(options["state-dir"], GIT_CREDENTIAL_FILE),
    takeGitStartupToken(),
  );
  const runtime = new WorksetRuntime({
    dockerHost: options["docker-host"],
    gitCredentials: gitTokens,
    stateDir: options["state-dir"],
    image: options.image,
    user: options.user,
    companionsDir: options["companions-dir"],
    ...(options.memory !== undefined
      ? {
          limits: {
            memory: options.memory,
            ...(options.agentMemory !== undefined ? { agentMemory: options.agentMemory } : {}),
            pids: options.pids ?? 1024,
            cpus: options.cpus ?? null,
          },
        }
      : {}),
    ...(options.maxWorksets !== undefined ? { maxWorksets: options.maxWorksets } : {}),
    ...(options.idleMinutes !== undefined ? { idleMinutes: options.idleMinutes } : {}),
  });
  fs.rmSync(options.socket, { force: true });
  const server = serveBroker(options.socket, brokerHandler(runtime, credentials, gitTokens));
  const attach = serveAttach(attachSocketFor(options.socket), { runtime, credentials });
  process.stderr.write(
    `mate factory: broker on ${options.socket}${credentials.current() ? "" : " (no Workset agent credential)"}\n`,
  );
  const sweep = (options.idleMinutes ?? 0) > 0 ? startIdleSweep(runtime) : null;
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        if (sweep) clearInterval(sweep);
        server.stop();
        attach.stop();
        resolve();
      });
    }
  });
}
