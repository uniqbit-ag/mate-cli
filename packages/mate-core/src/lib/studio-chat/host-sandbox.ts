import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";

import { freeLoopbackPort, signalProcessGroup, within } from "../../runtime/host-process";
import { isWithin, physicalPath } from "../../runtime/physical-path";
import { mateHome } from "../../runtime/runtime-directory";
import { writeAtomic } from "../../runtime/write-atomic";
import { CHAT_HARNESS_NAMES, type ChatHarness } from "./agent";

/**
 * The harness's sandbox as host processes, for the read-only Analysis chat: commands and the
 * Claude Code or OpenCode bridge run on this machine as the person running Studio. Each turn
 * gets a fresh temporary HOME, so the skills the harness writes and the transcripts it keeps
 * vanish with it; only the installed bridges are shared, through a cache linked into that HOME.
 * Files are written only under that HOME, and the bridge listens only on loopback.
 */

type SandboxSession = ReturnType<HarnessV1NetworkSandboxSession["restricted"]>;
type ProcessOptions = {
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
};

export interface HostSandboxOptions {
  /** The Companion Repository: the agent's working directory, never written. */
  workDir: string;
  /** The installed bridge, shared by turns; `~/.mate/cache/studio-chat/harness-bootstrap` when absent. */
  bootstrapCache?: string;
  /**
   * Installed bridges, one directory per harness id, used in place of the cache: never written,
   * and nothing is installed into them. The appliance's image sets them.
   */
  prebuiltBridges?: string;
  /** Inherited environment; `process.env` when absent. Credential variables are dropped. */
  env?: NodeJS.ProcessEnv;
}

export interface HostSandbox extends HarnessV1NetworkSandboxSession {
  /** The turn's temporary HOME. */
  readonly home: string;
  /** The loopback port the bridge binds. */
  readonly port: number;
}

class HostSandboxError extends Error {}

/**
 * Credentials either harness reads from the host; never inherited, so Studio passes none on.
 * A harness hands its bridge what it resolved through the spawn's own environment.
 */
export const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "XAI_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_COPILOT_TOKEN",
  "POE_API_KEY",
  "OPENCODE_API_KEY",
  "GITLAB_TOKEN",
  "AI_SDK_OPENCODE_NATIVE_ACCESS_TOKEN",
]);

/**
 * Where a harness finds configuration outside HOME: Claude Code's settings, hooks included,
 * OpenCode's config, data and plugins under the XDG directories, and OpenCode's config injected
 * through `OPENCODE_*`. Never inherited, so both read only the turn's HOME.
 */
const CONFIG_NAMES = new Set([
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
]);
const CONFIG_PREFIX = "OPENCODE_";

/** Where the harness keeps its bootstrap under HOME (`@ai-sdk/harness`'s state directory). */
const BOOTSTRAP_LINK = path.join(".ai-sdk-harness", ".harness-bootstrap");

/** The bridge binds every interface; on a host it must bind loopback only. */
const WILDCARD_BIND = 'host: "0.0.0.0"';
const LOOPBACK_BIND = 'host: "127.0.0.1"';
/** The harness's bridge start, capturing the bridge: it and its flags single-quoted, nothing chained. */
const BRIDGE_COMMAND =
  /^\s*(?:node|bun)\s+'([^']*\/bridge\.mjs)'(?:\s+--[\w-]+\s+'(?:[^']|'\\'')*')*\s*$/;
/**
 * A command that starts a script, at its start or after a separator, quote or `exec`: on this
 * host only the guarded bridge may run as one. `bun install` is the bootstrap's, not a script.
 */
const SCRIPT_START =
  /(?:^|[;&|(\n"'`]|\$\(|\bexec)\s*(?:node|bunx|npx|deno|tsx|bun(?!\s+install\s))(?:\s|$)/;
/**
 * A frozen-lockfile install whose flags Bun can drop without changing what or where it
 * installs: nothing named, nothing chained, no target directory.
 */
const LOCKFILE_INSTALL =
  /^(?:pnpm|npm|yarn)\s+(?:install|i|ci)(?:\s+(?:--frozen-lockfile|--prefer-offline|--silent|--store-dir[=\s][\w./-]+))*\s*$/;

const STOP_GRACE_MS = 2_000;

function defaultBootstrapCache(): string {
  return path.join(mateHome(), "cache", "studio-chat", "harness-bootstrap");
}

/**
 * The host has Bun, not necessarily pnpm or Node: the bootstrap's commands are run with Bun. A
 * lockfile install's flags are pnpm's, so it becomes `bun install --frozen-lockfile`, which
 * still installs only what the lockfile pins; any other install (packages named, commands
 * chained, a target directory or other flags) is left as is rather than silently changed.
 */
export function hostCommand(command: string): string {
  const trimmed = command.trimStart();
  if (LOCKFILE_INSTALL.test(trimmed)) return "bun install --frozen-lockfile";
  if (/^node(?=\s)/.test(trimmed)) return trimmed.replace(/^node/, "bun");
  return command;
}

/** The bridge source with its wildcard bind replaced by loopback; unchanged when absent. */
export function loopbackBridge(source: string): string {
  return source.replace(WILDCARD_BIND, LOOPBACK_BIND);
}

/** The bridge's own PreToolUse hooks (approval, then questions), which the companion guard goes before. */
const PRE_TOOL_USE = /PreToolUse:\s*\[/;
const READ_GUARD_MARK = "/* mate-studio-chat: reads stay in the companion, v3 */";
/** An earlier guard, in bridges installed before v3: replaced, so only the current one runs. */
const LEGACY_READ_GUARD =
  /\/\* mate-studio-chat: reads stay in the companion(?:, v2)? \*\/ \{[\s\S]*?\n {2}\}(?:\)\(\))?\],\n\}, /;
/**
 * A PreToolUse hook run in the bridge for every read tool, approved or not: it denies any path
 * that leads, links followed, outside the bridge's `workdir` and the turn's skills (written
 * under HOME), and any glob that, braces expanded, starts at `~`, has a segment that can match
 * `..`, or is absolute with its fixed part outside them. Claude Code's file tools read as the
 * person running Studio, so the instructions alone would not keep them in the companion.
 */
const READ_GUARD = `${READ_GUARD_MARK} {
  matcher: "Read|Grep|Glob|NotebookRead|LS",
  hooks: [(() => {
  // Search roots found clean, by when: a walk holds for the tool calls of one step, not longer,
  // since others (git, the person) may add a link to the companion meanwhile.
  const clean = new Map();
  const leaking = new Set();
  return async (hookInput) => {
    const nodePath = await import("node:path");
    const { realpathSync } = await import("node:fs");
    const { readdir } = await import("node:fs/promises");
    // Where the kernel lands: a link is followed before a later ".." applies, so "link/.." is its target's parent.
    const real = (target) => {
      const absolute = nodePath.isAbsolute(target) ? target : nodePath.resolve(workdir) + nodePath.sep + target;
      let current = nodePath.parse(absolute).root;
      for (const segment of absolute.slice(current.length).split(/[\\\\/]/)) {
        if (segment === "" || segment === ".") continue;
        current = segment === ".." ? nodePath.dirname(current) : nodePath.join(current, segment);
        try {
          current = realpathSync(current);
        } catch {
          // Missing: kept as written.
        }
      }
      return current;
    };
    // Every pattern the braces stand for, innermost first; null when there are too many to check.
    const expand = (glob) => {
      const done = [];
      const pending = [glob];
      while (pending.length > 0) {
        if (done.length + pending.length > 256) return null;
        const next = pending.pop();
        const group = /\\{([^{}]*)\\}/.exec(next);
        if (!group) done.push(next);
        else for (const part of group[1].split(",")) pending.push(next.slice(0, group.index) + part + next.slice(group.index + group[0].length));
      }
      return done;
    };
    const root = real(".");
    // The skills the harness writes for the turn; a skill's own files are read from there.
    const skills = process.env.HOME ? real(nodePath.join(process.env.HOME, ".claude", "skills")) : null;
    const under = (resolved, dir) => resolved === dir || resolved.startsWith(dir + nodePath.sep);
    const inside = (resolved) => under(resolved, root) || (skills !== null && under(resolved, skills));
    // A segment of only dots and single-character wildcards or classes can match "..".
    const parentLike = (segment) => segment.includes("..") || (segment.includes(".") && /^[.?[\\]()@!+|]*$/.test(segment));
    // An absolute pattern's segments before its first wildcard: where its search starts.
    const fixedPart = (pattern) => {
      const segments = pattern.split(/[\\\\/]/);
      const wild = segments.findIndex((segment) => /[*?[\\]()!+@]/.test(segment));
      return (wild === -1 ? segments : segments.slice(0, wild)).join("/") || "/";
    };
    const escapes = (glob) => {
      const patterns = expand(glob);
      return patterns === null || patterns.some((pattern) => pattern.startsWith("~") || pattern.split(/[\\\\/]/).some(parentLike) ||
        (nodePath.isAbsolute(pattern) && !inside(real(fixedPart(pattern)))));
    };
    // Grep and Glob follow links, so one anywhere below the search root may lead outside; too many entries to check counts as outside.
    const walk = async (dir) => {
      const pending = [dir];
      let seen = 0;
      while (pending.length > 0) {
        const current = pending.pop();
        let entries;
        try {
          entries = await readdir(current, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          seen += 1;
          if (seen > 1000000) return true;
          const full = nodePath.join(current, entry.name);
          if (entry.isSymbolicLink()) {
            if (!inside(real(full))) return true;
          } else if (entry.isDirectory()) pending.push(full);
        }
      }
      return false;
    };
    const linksOut = async (dir) => {
      const now = Date.now();
      for (const [done, at] of clean) {
        if (now - at > 5000) clean.delete(done);
        else if (under(dir, done)) return false;
      }
      if (leaking.has(dir)) return true;
      const out = await walk(dir);
      if (out) leaking.add(dir);
      else clean.set(dir, Date.now());
      return out;
    };
    const input = hookInput.tool_input ?? {};
    const paths = [input.file_path, input.notebook_path, input.path].filter((value) => typeof value === "string");
    const globs = [hookInput.tool_name === "Glob" ? input.pattern : undefined, input.glob].filter((value) => typeof value === "string");
    const searches = hookInput.tool_name === "Grep" || hookInput.tool_name === "Glob";
    // Claude Code expands a leading "~" to HOME, outside the companion.
    let outside = paths.some((target) => target.startsWith("~") || !inside(real(target))) || globs.some(escapes);
    if (!outside && searches) {
      const starts = [typeof input.path === "string" ? input.path : "."];
      for (const glob of globs) for (const pattern of expand(glob)) if (nodePath.isAbsolute(pattern)) starts.push(fixedPart(pattern));
      for (const start of starts) if (await linksOut(real(start))) outside = true;
    }
    if (!outside) return {};
    return { hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "The chat reads only files inside this companion.",
    } };
  };
  })()],
}`;

/** The bridge source with the companion read guard first among its PreToolUse hooks; unchanged when absent. */
export function companionReadGuard(source: string): string {
  if (source.includes(READ_GUARD_MARK)) return source;
  return source
    .replace(LEGACY_READ_GUARD, "")
    .replace(PRE_TOOL_USE, `PreToolUse: [${READ_GUARD}, `);
}

/** An option of the bridge's Claude Code query, where the settings sources go. */
const QUERY_OPTION = "includePartialMessages: true,";
const USER_SETTINGS_MARK = "/* mate-studio-chat: no companion settings */";

/**
 * The bridge source with Claude Code's settings read from the turn's HOME only (its skills
 * included), never the companion's `.claude/settings*.json`, whose hooks would run commands;
 * unchanged when absent.
 */
export function userSettingsOnly(source: string): string {
  if (source.includes(USER_SETTINGS_MARK)) return source;
  return source.replace(
    QUERY_OPTION,
    `${USER_SETTINGS_MARK} settingSources: ["user"], ${QUERY_OPTION}`,
  );
}

/** OpenCode's permissions for tools the chat never runs; `allow-reads` approves `webfetch` as a read. */
const OPENCODE_ASKED = /webfetch: "ask",(\s*)doom_loop: "ask",(\s*)task: "ask",/;
const OPENCODE_TOOLS_MARK = "/* mate-studio-chat: no web, no subagents */";

/**
 * The OpenCode bridge source with fetching, web search, subagents and todos denied, so OpenCode
 * offers none of them; unchanged when absent.
 */
export function openCodeToolsOff(source: string): string {
  if (source.includes(OPENCODE_TOOLS_MARK)) return source;
  return source.replace(
    OPENCODE_ASKED,
    `${OPENCODE_TOOLS_MARK} webfetch: "deny", websearch: "deny", codesearch: "deny", todowrite: "deny",$1doom_loop: "ask",$2task: "deny",`,
  );
}

/**
 * Each bridge's guards past the loopback bind: the rewrite applied to its source, the marks its
 * start requires, and the environment it starts with, over the harness's own. OpenCode's bridge
 * keeps reads in the companion itself, asking for any path outside it an approval nobody grants.
 */
const BRIDGE_GUARDS: Record<
  ChatHarness,
  {
    guard: (source: string) => string;
    marks: readonly (readonly [string, string])[];
    env: Readonly<Record<string, string>>;
  }
> = {
  "claude-code": {
    guard: (source) => companionReadGuard(userSettingsOnly(source)),
    marks: [
      [READ_GUARD_MARK, "the chat bridge must keep reads inside the companion"],
      [USER_SETTINGS_MARK, "the chat bridge must not load the companion's settings"],
    ],
    env: {},
  },
  opencode: {
    guard: openCodeToolsOff,
    marks: [
      [OPENCODE_TOOLS_MARK, "the chat bridge must not fetch, search the web or run subagents"],
    ],
    // No external plugins and no project configuration, for OpenCode's server too.
    env: { OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
  },
};

/** The harness a bridge belongs to, by its bootstrap directory; any other is refused. */
function bridgeKind(file: string): ChatHarness {
  const kind = path.basename(path.dirname(file));
  if (kind === "claude-code" || kind === "opencode") return kind;
  throw new HostSandboxError(`the chat starts no ${kind} bridge`);
}

/** The bridge source with every chat guard applied. */
function guardedBridge(source: string, kind: ChatHarness): string {
  return BRIDGE_GUARDS[kind].guard(loopbackBridge(source));
}

/** Bridge ports of this process's live sandboxes, so two turns never share one. */
const claimedPorts = new Set<number>();

async function claimBridgePort(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each probe follows a refused port.
    const port = await freeLoopbackPort();
    if (claimedPorts.has(port)) continue;
    claimedPorts.add(port);
    return port;
  }
  throw new HostSandboxError("no free loopback port for the chat bridge");
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function inheritedEnv(env: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || CREDENTIAL_NAMES.has(name)) continue;
    if (CONFIG_NAMES.has(name) || name.startsWith(CONFIG_PREFIX)) continue;
    kept[name] = value;
  }
  kept.HOME = home;
  return kept;
}

export async function createHostSandbox(options: HostSandboxOptions): Promise<HostSandbox> {
  const workDir = path.resolve(options.workDir);
  const prebuilt = options.prebuiltBridges;
  const cache = prebuilt ?? options.bootstrapCache ?? defaultBootstrapCache();
  if (!prebuilt) await mkdir(cache, { recursive: true });
  const home = await mkdtemp(path.join(os.tmpdir(), "mate-studio-chat-"));
  const { port, realWorkDir, realHome, realCache } = await prepareHome(home, cache, workDir).catch(
    async (error: unknown) => {
      await rm(home, { recursive: true, force: true });
      throw error;
    },
  );
  const env = inheritedEnv(options.env ?? process.env, home);
  /** Each running process with its end: exited and its pipes closed. */
  const children = new Map<ChildProcess, Promise<{ exitCode: number }>>();
  let stopped = false;

  const state = (real: string) => isWithin(real, realHome) || isWithin(real, realCache);
  /** Reads stay in the turn's state (its HOME and the linked bridge cache) and the companion. */
  const readable = (target: string): string => {
    const resolved = path.resolve(workDir, target);
    const real = physicalPath(resolved);
    if (state(real) || isWithin(real, realWorkDir)) return resolved;
    throw new HostSandboxError(`${target} is outside the chat's companion and state`);
  };
  /** A harness that would install or change its prebuilt bridge finds it missing or incomplete. */
  const incompleteBridge = (real: string) => {
    const harness = path.relative(realCache, real).split(path.sep)[0] ?? "";
    const name = CHAT_HARNESS_NAMES[harness as ChatHarness] ?? harness;
    return new HostSandboxError(
      `the prebuilt ${name} bridge in ${prebuilt} is missing or incomplete`,
    );
  };
  /** Writes only in the turn's state, never in the companion or a prebuilt bridge. */
  const writable = (target: string): string => {
    const resolved = path.resolve(workDir, target);
    const real = physicalPath(resolved);
    if (prebuilt && isWithin(real, realCache)) throw incompleteBridge(real);
    if (isWithin(resolved, home) && state(real) && !isWithin(real, realWorkDir)) return resolved;
    throw new HostSandboxError(`the chat writes nothing outside its own state: ${target}`);
  };

  /**
   * Every group started that may still have members: kept past its leader's exit, so members
   * that let go of its pipes are ended too. A group id is not reused while a member lives.
   */
  const groups = new Set<number>();

  /** Signals the child's group while it may have members, its leader exited or not. */
  const killGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (child.pid !== undefined && groups.has(child.pid)) signalProcessGroup(child.pid, signal);
  };

  /** Ends a child's group: TERM, then KILL, then lets go of its pipes. */
  const end = async (child: ChildProcess, exited: Promise<{ exitCode: number }>) => {
    killGroup(child, "SIGTERM");
    await within(exited, STOP_GRACE_MS);
    // A group outlives its leader when a member ignores SIGTERM.
    killGroup(child, "SIGKILL");
    await within(exited, STOP_GRACE_MS);
    // A process that left its group may still hold a pipe; letting go of it ends the wait.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
    await exited;
  };

  const start = (request: ProcessOptions, stdin: boolean) => {
    if (stopped) throw new HostSandboxError("the chat sandbox has stopped");
    request.abortSignal?.throwIfAborted();
    const cwd = readable(request.workingDirectory ?? workDir);
    // A process group of its own, so stopping ends everything it started.
    const child = spawnChild("bash", ["-c", hostCommand(request.command)], {
      cwd,
      env: { ...env, ...request.env },
      detached: true,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const onAbort = () => killGroup(child, "SIGTERM");
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      const done = (exitCode: number) => {
        children.delete(child);
        request.abortSignal?.removeEventListener("abort", onAbort);
        if (child.pid !== undefined && !groupAlive(child.pid)) groups.delete(child.pid);
        resolve({ exitCode });
      };
      child.once("close", (code) => done(code ?? 137));
      child.once("error", () => done(127));
    });
    if (child.pid !== undefined) groups.add(child.pid);
    children.set(child, exited);
    request.abortSignal?.addEventListener("abort", onAbort, { once: true });
    return { child, exited };
  };

  const run: SandboxSession["run"] = async (request: ProcessOptions) => {
    // The bridge runs only through `spawn`, where its guards are checked, however a command starts it.
    if (request.command.includes("bridge.mjs")) {
      throw new HostSandboxError("the chat bridge starts only through spawn");
    }
    if (SCRIPT_START.test(hostCommand(request.command))) {
      throw new HostSandboxError("the chat starts no script but its bridge");
    }
    // A harness that finds no installed bridge creates its bootstrap directory, then installs.
    if (prebuilt && request.env?.BOOTSTRAP_DIR !== undefined) {
      throw incompleteBridge(physicalPath(path.resolve(request.env.BOOTSTRAP_DIR)));
    }
    if (prebuilt && LOCKFILE_INSTALL.test(request.command.trimStart())) {
      throw incompleteBridge(physicalPath(readable(request.workingDirectory ?? workDir)));
    }
    const { child, exited } = start(request, false);
    let stdout = "";
    let stderr = "";
    // Decoded as a stream, so a character split across chunks stays whole.
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const { exitCode } = await exited;
    return { exitCode, stdout, stderr };
  };

  const spawn = async (request: ProcessOptions & { stdin?: boolean }) => {
    const bridge = BRIDGE_COMMAND.exec(request.command)?.[1];
    // A bridge started some other way, or renamed, would skip every check below.
    if (!bridge && request.command.includes("bridge.mjs")) {
      throw new HostSandboxError("the chat bridge must be started alone, from a quoted path");
    }
    if (!bridge && SCRIPT_START.test(hostCommand(request.command))) {
      throw new HostSandboxError("the chat starts no script but its bridge");
    }
    let guardEnv: Readonly<Record<string, string>> = {};
    if (bridge) {
      const { guard, marks, env: bridgeEnv } = BRIDGE_GUARDS[bridgeKind(bridge)];
      guardEnv = bridgeEnv;
      const file = readable(bridge);
      // Only an installed bridge: one in the companion could carry the marks and run anything.
      if (!isWithin(physicalPath(file), realCache)) {
        throw new HostSandboxError("the chat starts only its installed bridge");
      }
      let source = await readFile(file, "utf8");
      // A bridge installed before a guard existed gets it now; the bind is only checked.
      const guarded = guard(source);
      if (guarded !== source) {
        await writeAtomic(writable(bridge), guarded);
        source = guarded;
      }
      if (source.includes(WILDCARD_BIND) || !source.includes(LOOPBACK_BIND)) {
        throw new HostSandboxError("the chat bridge must listen on loopback only");
      }
      for (const [mark, reason] of marks) {
        if (!source.includes(mark)) throw new HostSandboxError(reason);
      }
    }
    const { child, exited } = start(
      { ...request, env: { ...request.env, ...guardEnv } },
      request.stdin === true,
    );
    const handle = {
      stdout: Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as unknown as ReadableStream<Uint8Array>,
      wait: () => exited,
      kill: () => end(child, exited),
    };
    if (!request.stdin) return handle;
    return { ...handle, stdin: Writable.toWeb(child.stdin!) as WritableStream<Uint8Array> };
  };

  const readBinaryFile = async ({ path: target }: { path: string }): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(await readFile(readable(target)));
    } catch (error) {
      if (error instanceof HostSandboxError) throw error;
      return null;
    }
  };

  const writeBinaryFile = async ({
    path: target,
    content,
  }: {
    path: string;
    content: Uint8Array;
  }) => {
    const file = writable(target);
    const bytes =
      path.basename(file) === "bridge.mjs"
        ? new TextEncoder().encode(
            guardedBridge(new TextDecoder().decode(content), bridgeKind(file)),
          )
        : content;
    await mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, bytes);
  };

  const restricted = {
    description: `This machine, read-only for the agent. The working directory is the Companion Repository ${workDir}.`,
    run,
    spawn,
    readBinaryFile,
    readFile: async ({ path: target }: { path: string }) => {
      const bytes = await readBinaryFile({ path: target });
      if (bytes === null) return null;
      return new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    readTextFile: async ({
      path: target,
      startLine,
      endLine,
    }: {
      path: string;
      startLine?: number;
      endLine?: number;
    }) => {
      const bytes = await readBinaryFile({ path: target });
      if (bytes === null) return null;
      const text = new TextDecoder().decode(bytes);
      if (startLine === undefined && endLine === undefined) return text;
      return text
        .split("\n")
        .slice((startLine ?? 1) - 1, endLine)
        .join("\n");
    },
    writeBinaryFile,
    writeTextFile: ({ path: target, content }: { path: string; content: string }) =>
      writeBinaryFile({ path: target, content: new TextEncoder().encode(content) }),
    writeFile: async ({
      path: target,
      content,
    }: {
      path: string;
      content: ReadableStream<Uint8Array>;
    }) =>
      writeBinaryFile({
        path: target,
        content: new Uint8Array(await new Response(content).arrayBuffer()),
      }),
  } as unknown as SandboxSession;

  const endpoint = async ({
    port: asked,
    protocol,
  }: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }) => {
    if (asked !== port) throw new HostSandboxError(`port ${asked} is not the chat bridge's`);
    return { url: `${protocol ?? "http"}://127.0.0.1:${port}` };
  };

  /** Ends every process group, then removes the HOME with all it held. */
  const stop = async () => {
    stopped = true;
    const leaders = new Set([...children.keys()].map((child) => child.pid));
    const orphaned = [...groups].filter((pid) => !leaders.has(pid) && groupAlive(pid));
    for (const pid of orphaned) signalProcessGroup(pid, "SIGTERM");
    await Promise.all([
      ...[...children].map(([child, exited]) => end(child, exited)),
      ...(orphaned.length > 0 ? [delay(STOP_GRACE_MS)] : []),
    ]);
    for (const pid of orphaned) signalProcessGroup(pid, "SIGKILL");
    groups.clear();
    claimedPorts.delete(port);
    await rm(home, { recursive: true, force: true });
  };

  return {
    ...restricted,
    id: `studio-chat-${path.basename(home)}`,
    home,
    port,
    defaultWorkingDirectory: workDir,
    ports: [port],
    getPortEndpoint: endpoint,
    getPortUrl: async (request: { port: number; protocol?: "http" | "https" | "ws" }) =>
      (await endpoint(request)).url,
    stop,
    destroy: stop,
    restricted: () => restricted,
  } as unknown as HostSandbox;
}

/** The HOME's link to the bootstrap cache, the paths checks compare against, and the bridge port. */
async function prepareHome(home: string, cache: string, workDir: string) {
  await mkdir(path.join(home, path.dirname(BOOTSTRAP_LINK)), { recursive: true });
  await symlink(cache, path.join(home, BOOTSTRAP_LINK));
  // A skill's inline shell commands would run on the host; Claude Code shows a placeholder instead.
  await mkdir(path.join(home, ".claude"));
  await writeFile(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ disableSkillShellExecution: true }),
  );
  // Checked with links followed, so a link inside the companion cannot lead outside it.
  const [realWorkDir, realHome, realCache] = [workDir, home, cache].map(physicalPath) as [
    string,
    string,
    string,
  ];
  // Claimed last: nothing after it can fail and leave it claimed.
  const port = await claimBridgePort();
  return { port, realWorkDir, realHome, realCache };
}
