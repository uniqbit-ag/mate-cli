import { FRAMEWORK_NAME } from "../../../framework";
import { openReportInBrowser } from "../report/delivery";
import {
  serveUntilInterrupted,
  startStudioServer,
  STUDIO_HOSTNAME,
  type StudioServerHandle,
  type StudioServerOptions,
} from "./server";

export interface StudioCommandDeps {
  startStudioServer?: typeof startStudioServer;
  serveUntilInterrupted?: typeof serveUntilInterrupted;
  openInBrowser?: (url: string) => Promise<void>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export type StudioServeArgs = StudioServerOptions & { port: number; hostname: string };

export function parseStudioServeArgs(argv: string[]): StudioServeArgs | { error: string } {
  let port: number | undefined;
  let hostname = STUDIO_HOSTNAME;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--writable") {
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const value = arg === "--port" ? argv[index + 1] : arg.slice("--port=".length);
      if (!value || value.startsWith("--")) return { error: "--port requires a value" };
      const parsed = Number(value);
      if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return { error: `invalid --port value: ${value}` };
      }
      port = parsed;
      if (arg === "--port") index += 1;
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const value = arg === "--host" ? argv[index + 1] : arg.slice("--host=".length);
      if (!value || value.startsWith("--")) return { error: "--host requires a value" };
      hostname = value;
      if (arg === "--host") index += 1;
      continue;
    }
    return { error: `unknown studio serve option: ${arg}` };
  }

  if (port === undefined) return { error: "studio serve requires --port" };
  return { port, hostname, writable: argv.includes("--writable") };
}

/**
 * @command mate studio
 * @description Serves a local page over the Companion Repositories
 * registered on this machine — the workflow drawn from each companion's
 * resolved schema with its OpenSpec state on it — and opens the platform
 * browser at it. Runs in the foreground on an operating-system-assigned
 * loopback port and dies with the process: no daemon, no stop command, and no
 * state written anywhere.
 * @remarks Both invocations are read-only unless passed `--writable`. Neither
 * invocation resolves a Repository Link, so it runs from any directory.
 */
export async function runStudioCommand(
  argv: string[] = [],
  deps: StudioCommandDeps = {},
): Promise<void> {
  const log = deps.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  if (argv[0] === "serve") {
    await runStudioServeCommand(argv.slice(1), deps, log, warn);
    return;
  }

  if (argv.some((arg) => arg !== "--writable")) {
    warn(`${FRAMEWORK_NAME}: \`studio\` takes no arguments; unrecognized: ${argv.join(" ")}`);
    process.exitCode = 1;
    return;
  }

  const start = deps.startStudioServer ?? startStudioServer;
  const serve = deps.serveUntilInterrupted ?? serveUntilInterrupted;
  const open = deps.openInBrowser ?? openReportInBrowser;

  let server;
  try {
    server = start({}, { writable: argv.includes("--writable") });
  } catch (error) {
    warn(
      `${FRAMEWORK_NAME}: studio could not bind a port: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }

  log(server.url);
  log("Press Ctrl+C to stop.");

  try {
    await open(server.url);
  } catch (error) {
    warn(
      `${FRAMEWORK_NAME}: studio could not open a browser: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    warn(`${FRAMEWORK_NAME}: open ${server.url} manually; the server keeps serving.`);
  }

  await serve(server);
}

async function runStudioServeCommand(
  argv: string[],
  deps: StudioCommandDeps,
  log: (message: string) => void,
  warn: (message: string) => void,
): Promise<void> {
  const parsed = parseStudioServeArgs(argv);
  if ("error" in parsed) {
    warn(`${FRAMEWORK_NAME}: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const start = deps.startStudioServer ?? startStudioServer;
  const serve = deps.serveUntilInterrupted ?? serveUntilInterrupted;
  let server: StudioServerHandle;
  try {
    server = start({}, parsed);
  } catch (error) {
    warn(
      `${FRAMEWORK_NAME}: studio serve could not bind ${parsed.hostname}:${parsed.port}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }

  log(server.url);
  await serve(server);
}
