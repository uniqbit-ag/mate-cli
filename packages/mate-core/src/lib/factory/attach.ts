import fs from "node:fs";
import net from "node:net";

import type { AgentCredential } from "./broker";
import {
  encodeControl,
  encodeData,
  encodeStderr,
  type Frame,
  FRAME_CONTROL,
  FrameDecoder,
  FrameError,
} from "./frames";
import { FactoryError } from "./ids";
import {
  bunPtySpawn,
  nodePipeSpawn,
  type PipeProcess,
  type PipeSpawn,
  type PtyProcess,
  type PtySpawn,
} from "./pty";
import { SESSION_MARKER, type WorksetRuntime } from "./runtime";

/**
 * The broker's attach socket: an interactive agent in a Workset container, relayed
 * as frames over a Unix socket. The first frame names the Workset, the session and
 * the command; the broker runs `docker exec -it` in its own PTY with the agent
 * credential and the session marker in that client's environment only. When the
 * connection closes for any reason, the broker stops the marked processes inside
 * the container.
 */

const START_FIELDS = new Set(["type", "id", "session", "command", "agent", "cols", "rows", "tty"]);
const SIZE = { cols: [2, 500], rows: [1, 300] } as const;

function inRange(value: unknown, [min, max]: readonly [number, number]): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export interface AttachServerOptions {
  runtime: WorksetRuntime;
  credential: AgentCredential | null;
  spawn?: PtySpawn;
  /** For `tty: false` attaches, such as the harness bridge. */
  spawnPipe?: PipeSpawn;
  /** The broker's environment for the `docker` client, credential already taken out. */
  env?: NodeJS.ProcessEnv;
}

/** Handles one attach connection; exposed so tests can drive it with an in-memory socket. */
export function handleAttach(socket: net.Socket, options: AttachServerOptions): void {
  const spawn = options.spawn ?? bunPtySpawn;
  const spawnPipe = options.spawnPipe ?? nodePipeSpawn;
  const decoder = new FrameDecoder();
  let pty: PtyProcess | PipeProcess | null = null;
  let started: { id: string; session: string } | null = null;
  let starting = false;
  let closed = false;

  const fail = (reason: string) => {
    if (!socket.destroyed) socket.end(encodeControl({ type: "error", reason }));
  };

  const start = async (message: Record<string, unknown>) => {
    starting = true;
    const extra = Object.keys(message).filter((key) => !START_FIELDS.has(key));
    if (extra.length > 0) return fail(`the broker does not accept ${extra.join(", ")}`);
    if (message.tty !== undefined && typeof message.tty !== "boolean") {
      return fail("tty must be true or false");
    }
    const tty = message.tty !== false;
    if (tty && (!inRange(message.cols, SIZE.cols) || !inRange(message.rows, SIZE.rows))) {
      return fail("terminal size out of range");
    }
    if (message.agent !== undefined && typeof message.agent !== "boolean") {
      return fail("agent must be true or false");
    }
    if (message.agent === true && options.credential === null) {
      return fail(
        "no Workset agent credential is configured; set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
      );
    }
    const credential = message.agent === true ? options.credential : null;
    let argv: string[];
    try {
      argv = await options.runtime.attachCommand({
        id: message.id as string,
        command: message.command as string[],
        session: message.session as string,
        envNames: credential ? [credential.name] : [],
        tty,
      });
    } catch (error) {
      return fail(error instanceof FactoryError ? error.message : "the attach could not start");
    }
    if (closed) return;
    started = { id: message.id as string, session: message.session as string };
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env ?? process.env)) {
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, options.runtime.dockerEnv(), {
      [SESSION_MARKER]: started.session,
      TERM: "xterm-256color",
    });
    if (credential) env[credential.name] = credential.value;
    const onData = (data: Uint8Array) => {
      if (!socket.destroyed) socket.write(encodeData(data));
    };
    pty = tty
      ? spawn({ argv, env, cols: message.cols as number, rows: message.rows as number, onData })
      : spawnPipe({
          argv,
          env,
          cols: 0,
          rows: 0,
          onData,
          onStderr: (data) => {
            if (!socket.destroyed) socket.write(encodeStderr(data));
          },
        });
    void pty.exited.then((status) => {
      if (!socket.destroyed) socket.end(encodeControl({ type: "exit", status }));
    });
  };

  const frame = (entry: Frame) => {
    if (entry.type === FRAME_CONTROL) {
      if (entry.message.type === "start" && !starting) {
        void start(entry.message);
      } else if (entry.message.type === "eof" && pty && "end" in pty) {
        pty.end();
      } else if (entry.message.type === "resize" && pty) {
        if (inRange(entry.message.cols, SIZE.cols) && inRange(entry.message.rows, SIZE.rows)) {
          pty.resize(entry.message.cols, entry.message.rows);
        }
      } else if (!starting) {
        fail("the first frame must start the attach");
      }
      return;
    }
    if (pty) pty.write(entry.data);
  };

  socket.on("data", (chunk: Buffer) => {
    let frames: Frame[];
    try {
      frames = decoder.push(new Uint8Array(chunk));
    } catch (error) {
      fail(error instanceof FrameError ? error.message : "malformed frame");
      return;
    }
    for (const entry of frames) frame(entry);
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
    pty?.kill("SIGHUP");
    if (started) {
      void options.runtime.stopMarked(started.id, started.session).catch((error: unknown) => {
        process.stderr.write(
          `mate factory: stopping session ${started!.session} in ${started!.id} failed: ${(error as Error).message}\n`,
        );
      });
    }
  });
}

export function serveAttach(
  socketPath: string,
  options: AttachServerOptions,
): { stop: () => void } {
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => handleAttach(socket, options));
  server.listen(socketPath);
  return { stop: () => server.close() };
}
