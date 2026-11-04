import net from "node:net";
import path from "node:path";

import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";

import { AGENT_CREDENTIAL_NAMES } from "./broker";
import { bunCommand } from "./bun-commands";
import type { FactoryClient } from "./client";
import {
  encodeControl,
  encodeData,
  FRAME_CONTROL,
  FRAME_DATA,
  FRAME_STDERR,
  FrameDecoder,
} from "./frames";
import { FactoryError } from "./ids";

/**
 * The harness's sandbox, made of the factory broker: commands and files through broker
 * `exec`, long-running processes (the Claude Code bridge) through the non-TTY attach,
 * ports through the container's inner-network address. Studio never holds the agent
 * credential: a process the harness starts with a credential variable is started with
 * `agent: true` instead, and the broker sets the real value inside the container.
 */

type SandboxSession = ReturnType<HarnessV1NetworkSandboxSession["restricted"]>;
type ProcessOptions = {
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
};

export interface WorksetSandboxOptions {
  /** The Workset identifier. */
  id: string;
  /** Absolute worktree path, identical inside the container. */
  worktree: string;
  /** The unprivileged user's home inside the container, where harness state lives. */
  home: string;
  client: FactoryClient;
  attachSocket: string;
  /** The port the bridge binds inside the container. */
  bridgePort: number;
  /** Long-running processes are the harness bridge: start each with the agent credential. */
  agentSpawns?: boolean;
  /** A fresh session marker per spawned process. */
  sessionId: () => string;
  connect?: (socketPath: string) => net.Socket;
}

const CREDENTIAL_NAMES = new Set<string>(AGENT_CREDENTIAL_NAMES);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Splits the harness's environment into plain variables and whether it asked for the credential. */
function splitEnv(env: Record<string, string> = {}): {
  plain: Record<string, string>;
  agent: boolean;
} {
  const plain: Record<string, string> = {};
  let agent = false;
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name))
      throw new FactoryError(`environment variable ${JSON.stringify(name)} is invalid`);
    if (CREDENTIAL_NAMES.has(name)) agent = true;
    else plain[name] = value;
  }
  return { plain, agent };
}

/** `env K=V … bash -c <command>`, Node tools rewritten to Bun; credential variables never appear here. */
function wrap(command: string, cwd: string, env: Record<string, string>): string[] {
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  return ["env", ...assignments, "bash", "-c", `cd ${shellQuote(cwd)} && ${bunCommand(command)}`];
}

export function createWorksetSandbox(
  options: WorksetSandboxOptions,
): HarnessV1NetworkSandboxSession {
  const roots = [options.worktree, options.home];
  const connect = options.connect ?? ((socketPath: string) => net.connect(socketPath));
  const live = new Set<net.Socket>();

  /** Absolute and inside the worktree or the harness's home; anything else is refused. */
  const resolvePath = (target: string): string => {
    const resolved = path.resolve(options.worktree, target);
    if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
      throw new FactoryError(`${target} is outside the Workset's worktree and home`);
    }
    return resolved;
  };

  const exec = (command: string[], extra: { stdin?: Uint8Array; agent?: boolean } = {}) =>
    options.client.exec({ id: options.id, command, ...extra });

  const run: SandboxSession["run"] = async (process: ProcessOptions) => {
    const cwd = resolvePath(process.workingDirectory ?? options.worktree);
    const { plain, agent } = splitEnv(process.env);
    const result = await exec(wrap(process.command, cwd, plain), agent ? { agent } : {});
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  const readBinaryFile = async ({ path: target }: { path: string }): Promise<Uint8Array | null> => {
    const file = resolvePath(target);
    const result = await exec([
      "sh",
      "-c",
      'test -f "$1" || exit 3; base64 -w0 -- "$1"',
      "read",
      file,
    ]);
    if (result.status === 3) return null;
    if (result.status !== 0)
      throw new FactoryError(`reading ${target} failed: ${result.stderr.trim()}`);
    return new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
  };

  const writeBinaryFile = async ({
    path: target,
    content,
  }: {
    path: string;
    content: Uint8Array;
  }) => {
    const file = resolvePath(target);
    const result = await exec(
      ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "write", file],
      { stdin: content },
    );
    if (result.status !== 0)
      throw new FactoryError(`writing ${target} failed: ${result.stderr.trim()}`);
  };

  const spawnProcess = async (process: ProcessOptions & { stdin?: boolean }) => {
    const cwd = resolvePath(process.workingDirectory ?? options.worktree);
    const { plain, agent: asked } = splitEnv(process.env);
    const agent = asked || options.agentSpawns === true;
    const socket = connect(options.attachSocket);
    live.add(socket);
    const decoder = new FrameDecoder();
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (stdoutController = c) });
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (stderrController = c) });
    let exitCode: number | null = null;
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      socket.on("close", () => {
        live.delete(socket);
        for (const controller of [stdoutController, stderrController]) {
          try {
            controller.close();
          } catch {
            /** Already closed. */
          }
        }
        resolve({ exitCode: exitCode ?? 137 });
      });
    });
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        if (frame.type === FRAME_DATA) stdoutController.enqueue(frame.data);
        else if (frame.type === FRAME_STDERR) stderrController.enqueue(frame.data);
        else if (frame.type === FRAME_CONTROL && frame.message.type === "exit") {
          exitCode = typeof frame.message.status === "number" ? frame.message.status : 1;
        } else if (frame.type === FRAME_CONTROL && frame.message.type === "error") {
          stderrController.enqueue(new TextEncoder().encode(`${String(frame.message.reason)}\n`));
          exitCode = 1;
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", (error) =>
        reject(new FactoryError(`the factory broker is not reachable: ${error.message}`)),
      );
    });
    socket.write(
      encodeControl({
        type: "start",
        id: options.id,
        session: options.sessionId(),
        command: wrap(process.command, cwd, plain),
        agent,
        tty: false,
      }),
    );
    process.abortSignal?.addEventListener("abort", () => socket.destroy(), { once: true });
    const handle = {
      stdout,
      stderr,
      wait: () => exited,
      // Closing the attach makes the broker stop the process and all it started.
      kill: async () => {
        socket.destroy();
        await exited;
      },
    };
    if (!process.stdin) return handle;
    return {
      ...handle,
      stdin: new WritableStream<Uint8Array>({
        write: (chunk) => void socket.write(encodeData(chunk)),
        close: () => void socket.write(encodeControl({ type: "eof" })),
      }),
    };
  };

  const restricted = {
    description: `A Mate Workset container. The worktree is ${options.worktree}; commands run there as an unprivileged user with their own Docker daemon.`,
    run,
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
    }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of content as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
      await writeBinaryFile({ path: target, content: new Uint8Array(Buffer.concat(chunks)) });
    },
    spawn: spawnProcess,
  } as unknown as SandboxSession;

  const endpoint = async ({
    port,
    protocol,
  }: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }) => {
    if (port !== options.bridgePort)
      throw new FactoryError(`port ${port} is not exposed by this Workset`);
    return { url: `${protocol ?? "http"}://${await options.client.address(options.id)}:${port}` };
  };

  const stop = async () => {
    for (const socket of live) socket.destroy();
  };

  return {
    ...restricted,
    id: `workset-${options.id}`,
    defaultWorkingDirectory: options.worktree,
    ports: [options.bridgePort],
    getPortEndpoint: endpoint,
    getPortUrl: async (request: { port: number; protocol?: "http" | "https" | "ws" }) =>
      (await endpoint(request)).url,
    // The Workset container outlives a run; only this run's processes stop.
    stop,
    destroy: stop,
    restricted: () => restricted,
  } as unknown as HarnessV1NetworkSandboxSession;
}
