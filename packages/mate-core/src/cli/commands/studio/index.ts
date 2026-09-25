import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { openReportInBrowser } from "../report/delivery";
import { normalizeAuthority, normalizeOrigin, validateStudioToken } from "./access";
import { collectStudioInventory, type StudioInventory } from "./inventory";
import {
  serveUntilInterrupted,
  startStudioServer,
  STUDIO_HOSTNAME,
  type StudioServerHandle,
  type StudioServerOptions,
} from "./server";
import { terminalUnsupportedReason } from "./terminal";

export interface StudioCommandDeps {
  startStudioServer?: typeof startStudioServer;
  serveUntilInterrupted?: typeof serveUntilInterrupted;
  openInBrowser?: (url: string) => Promise<void>;
  collectStudioInventory?: () => Promise<StudioInventory>;
  terminalUnsupportedReason?: () => string | null;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export type StudioServeArgs = StudioServerOptions & { port: number; hostname: string };

export type StudioInteractiveArgs = Pick<
  StudioServerOptions,
  "writable" | "terminal" | "detachMinutes"
>;

interface ParseState {
  writable: boolean;
  terminal: boolean;
  detachMinutes?: number;
}

/**
 * Reads one `--flag value` / `--flag=value` pair. `undefined` when `arg` is not
 * that flag; `{ error }` when its value is missing.
 */
function flagValue(
  argv: string[],
  index: number,
  flag: string,
): { value: string; consumed: number } | { error: string } | undefined {
  const arg = argv[index]!;
  if (arg !== flag && !arg.startsWith(`${flag}=`)) return undefined;
  const value = arg === flag ? argv[index + 1] : arg.slice(flag.length + 1);
  if (!value || value.startsWith("--")) return { error: `${flag} requires a value` };
  return { value, consumed: arg === flag ? 2 : 1 };
}

/** Flags shared by both invocations; returns how many arguments were consumed, 0 when none. */
function parseSharedFlag(
  argv: string[],
  index: number,
  state: ParseState,
): number | { error: string } {
  const arg = argv[index]!;
  if (arg === "--writable") {
    state.writable = true;
    return 1;
  }
  if (arg === "--terminal") {
    state.terminal = true;
    return 1;
  }
  const detach = flagValue(argv, index, "--detach-timeout");
  if (!detach) return 0;
  if ("error" in detach) return detach;
  if (!/^\d+$/.test(detach.value) || Number(detach.value) < 1) {
    return { error: `invalid --detach-timeout value: ${detach.value} (whole minutes, at least 1)` };
  }
  state.detachMinutes = Number(detach.value);
  return detach.consumed;
}

function checkTerminal(state: ParseState): { error: string } | null {
  if (state.terminal && !state.writable) {
    return { error: "--terminal requires --writable" };
  }
  return null;
}

export function parseStudioArgs(argv: string[]): StudioInteractiveArgs | { error: string } {
  const state: ParseState = { writable: false, terminal: false };
  for (let index = 0; index < argv.length;) {
    const consumed = parseSharedFlag(argv, index, state);
    if (typeof consumed === "object") return consumed;
    if (consumed === 0) return { error: `unrecognized studio argument: ${argv[index]}` };
    index += consumed;
  }
  return (
    checkTerminal(state) ?? {
      writable: state.writable,
      ...(state.terminal ? { terminal: true } : {}),
      ...(state.detachMinutes !== undefined ? { detachMinutes: state.detachMinutes } : {}),
    }
  );
}

export function parseStudioServeArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): StudioServeArgs | { error: string } {
  let port: number | undefined;
  let hostname = STUDIO_HOSTNAME;
  let token: string | undefined;
  let publicOrigin: string | undefined;
  let companion: string | undefined;
  let noGit = false;
  const allowedHosts: string[] = [];
  const state: ParseState = { writable: false, terminal: false };

  for (let index = 0; index < argv.length;) {
    const arg = argv[index]!;
    const shared = parseSharedFlag(argv, index, state);
    if (typeof shared === "object") return shared;
    if (shared > 0) {
      index += shared;
      continue;
    }
    if (arg === "--no-git") {
      noGit = true;
      index += 1;
      continue;
    }
    const portFlag = flagValue(argv, index, "--port");
    if (portFlag) {
      if ("error" in portFlag) return portFlag;
      const parsed = Number(portFlag.value);
      if (!/^\d+$/.test(portFlag.value) || parsed < 1 || parsed > 65535) {
        return { error: `invalid --port value: ${portFlag.value}` };
      }
      port = parsed;
      index += portFlag.consumed;
      continue;
    }
    const valued = (
      [
        ["--host", (value: string) => (hostname = value)],
        ["--token", (value: string) => (token = value)],
        ["--allowed-host", (value: string) => allowedHosts.push(...splitHosts(value))],
        ["--public-origin", (value: string) => (publicOrigin = value)],
        ["--companion", (value: string) => (companion = value)],
      ] as const
    ).find(([flag]) => flagValue(argv, index, flag) !== undefined);
    if (valued) {
      const read = flagValue(argv, index, valued[0])!;
      if ("error" in read) return read;
      valued[1](read.value);
      index += read.consumed;
      continue;
    }
    return { error: `unknown studio serve option: ${arg}` };
  }

  if (port === undefined) return { error: "studio serve requires --port" };
  const terminalError = checkTerminal(state);
  if (terminalError) return terminalError;

  token ??= env.MATE_STUDIO_TOKEN || undefined;
  if (token !== undefined) {
    const weak = validateStudioToken(token);
    if (weak) return { error: `--token / MATE_STUDIO_TOKEN: ${weak}` };
  }
  if (env.MATE_STUDIO_ALLOWED_HOSTS)
    allowedHosts.push(...splitHosts(env.MATE_STUDIO_ALLOWED_HOSTS));
  for (const host of allowedHosts) {
    if (!normalizeAuthority(host)) {
      return { error: `--allowed-host / MATE_STUDIO_ALLOWED_HOSTS: invalid host: ${host}` };
    }
  }
  publicOrigin ??= env.MATE_STUDIO_PUBLIC_ORIGIN || undefined;
  if (publicOrigin !== undefined && !normalizeOrigin(publicOrigin)) {
    return {
      error: `--public-origin / MATE_STUDIO_PUBLIC_ORIGIN: expected http(s)://host[:port], got ${publicOrigin}`,
    };
  }

  return {
    port,
    hostname,
    writable: state.writable,
    invocation: "serve",
    ...(state.terminal ? { terminal: true } : {}),
    ...(state.detachMinutes !== undefined ? { detachMinutes: state.detachMinutes } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    ...(companion !== undefined ? { launchCompanion: path.resolve(companion) } : {}),
    ...(noGit ? { noGit: true } : {}),
  };
}

function splitHosts(value: string): string[] {
  return value
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

/**
 * @command mate studio
 * @description Serves a local page over the Companion Repositories
 * registered on this machine — the workflow drawn from each companion's
 * resolved schema with its OpenSpec state on it — and opens the platform
 * browser at it. Runs in the foreground on an operating-system-assigned
 * loopback port and dies with the process: no daemon, no stop command, and no
 * state written anywhere.
 * @remarks Both invocations are read-only unless passed `--writable`.
 * `--terminal` adds the agent terminal and guards Studio with a per-start
 * access token; `serve` is always guarded. Neither invocation resolves a
 * Repository Link, so it runs from any directory.
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

  const parsed = parseStudioArgs(argv);
  if ("error" in parsed) {
    warn(`${FRAMEWORK_NAME}: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }
  if (!terminalAvailable(parsed, deps, warn)) return;

  const start = deps.startStudioServer ?? startStudioServer;
  const serve = deps.serveUntilInterrupted ?? serveUntilInterrupted;
  const open = deps.openInBrowser ?? openReportInBrowser;

  let server;
  try {
    server = start({}, parsed);
  } catch (error) {
    warn(
      `${FRAMEWORK_NAME}: studio could not bind a port: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }

  log(server.address);
  log("Press Ctrl+C to stop.");

  try {
    await open(server.address);
  } catch (error) {
    warn(
      `${FRAMEWORK_NAME}: studio could not open a browser: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    warn(`${FRAMEWORK_NAME}: open ${server.address} manually; the server keeps serving.`);
  }

  await serve(server);
}

function terminalAvailable(
  options: Pick<StudioServerOptions, "terminal">,
  deps: StudioCommandDeps,
  warn: (message: string) => void,
): boolean {
  if (!options.terminal) return true;
  const reason = (deps.terminalUnsupportedReason ?? terminalUnsupportedReason)();
  if (!reason) return true;
  warn(`${FRAMEWORK_NAME}: --terminal ${reason}`);
  process.exitCode = 1;
  return false;
}

async function runStudioServeCommand(
  argv: string[],
  deps: StudioCommandDeps,
  log: (message: string) => void,
  warn: (message: string) => void,
): Promise<void> {
  const parsed = parseStudioServeArgs(argv, deps.env ?? process.env);
  if ("error" in parsed) {
    warn(`${FRAMEWORK_NAME}: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }
  if (!terminalAvailable(parsed, deps, warn)) return;

  if (parsed.launchCompanion) {
    const inventory = await (deps.collectStudioInventory ?? collectStudioInventory)();
    if (!inventory.companions.some((companion) => companion.path === parsed.launchCompanion)) {
      warn(
        `${FRAMEWORK_NAME}: --companion ${parsed.launchCompanion} is not a registered Companion Repository`,
      );
      process.exitCode = 1;
      return;
    }
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

  log(server.address);
  if (parsed.token) log("Access token: the value pinned by --token / MATE_STUDIO_TOKEN.");
  await serve(server);
}
