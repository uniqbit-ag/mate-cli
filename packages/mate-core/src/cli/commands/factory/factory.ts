import fs from "node:fs";

import { serveAttach } from "../../../lib/factory/attach";
import {
  agentCommand,
  ATTACH_STARTS,
  type AttachStart,
  runAttach,
  worksetIntent,
} from "../../../lib/factory/attach-client";
import { brokerHandler, serveBroker, takeAgentCredential } from "../../../lib/factory/broker";
import { attachSocketFor, FACTORY_BROKER_ENV } from "../../../lib/factory/client";
import { WorksetRuntime } from "../../../lib/factory/runtime";
import { usage } from "../../usage";
import { runFactorySetup, terminalIo } from "./setup";

const SERVE_OPTIONS = [
  "socket",
  "docker-host",
  "state-dir",
  "image",
  "user",
  "companions-dir",
] as const;
type ServeOption = (typeof SERVE_OPTIONS)[number];

export function parseServeArgs(argv: string[]): Record<ServeOption, string> | { error: string } {
  const values: Partial<Record<ServeOption, string>> = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!.replace(/^--/, "") as ServeOption;
    const value = argv[index + 1];
    if (!argv[index]!.startsWith("--") || !SERVE_OPTIONS.includes(name)) {
      return { error: `unknown option ${argv[index]}` };
    }
    if (value === undefined || value.startsWith("--")) return { error: `--${name} needs a value` };
    values[name] = value;
    index++;
  }
  const missing = SERVE_OPTIONS.filter((name) => values[name] === undefined);
  if (missing.length > 0)
    return { error: `missing ${missing.map((name) => `--${name}`).join(", ")}` };
  return values as Record<ServeOption, string>;
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
}

export function parseAttachArgs(argv: string[]): AttachArgs | { error: string } {
  const [id, ...rest] = argv;
  if (!id || id.startsWith("--")) return { error: "name the Workset to attach to" };
  const values: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]!.replace(/^--/, "");
    const value = rest[index + 1];
    if (!rest[index]!.startsWith("--") || !["session", "start", "companion"].includes(name)) {
      return { error: `unknown option ${rest[index]}` };
    }
    if (value === undefined) return { error: `--${name} needs a value` };
    values[name] = value;
  }
  if (!values.session || !values.companion) {
    return { error: "--session and --companion are required" };
  }
  const start = (values.start ?? "continue") as AttachStart;
  if (!ATTACH_STARTS.includes(start)) {
    return { error: `--start must be one of ${ATTACH_STARTS.join(", ")}` };
  }
  return { id, session: values.session, start, companion: values.companion };
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
    { id: args.id, session: args.session, command: agentCommand(args.start, intent) },
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
  if (subcommand === "setup") {
    if (argv.length > 0) {
      console.error("mate factory setup: takes no options; it asks for what it needs");
      process.exitCode = 1;
      return;
    }
    process.exitCode = await runFactorySetup(terminalIo());
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
  const credential = takeAgentCredential();
  const runtime = new WorksetRuntime({
    dockerHost: options["docker-host"],
    stateDir: options["state-dir"],
    image: options.image,
    user: options.user,
    companionsDir: options["companions-dir"],
  });
  fs.rmSync(options.socket, { force: true });
  const server = serveBroker(options.socket, brokerHandler(runtime, credential));
  const attach = serveAttach(attachSocketFor(options.socket), { runtime, credential });
  process.stderr.write(
    `mate factory: broker on ${options.socket}${credential ? "" : " (no Workset agent credential)"}\n`,
  );
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        server.stop();
        attach.stop();
        resolve();
      });
    }
  });
}
