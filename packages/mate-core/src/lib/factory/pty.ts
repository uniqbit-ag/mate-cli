import { spawn } from "node:child_process";

/** A pseudo-terminal child process, on Bun's native PTY; replaced by a fake in tests. */

export interface PtyProcess {
  pid: number;
  exited: Promise<number>;
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  kill(signal: NodeJS.Signals): void;
}

export interface PtyRequest {
  argv: string[];
  env: Record<string, string>;
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void;
}

export type PtySpawn = (request: PtyRequest) => PtyProcess;

/** A child without a terminal: separate stdout and stderr, and a closable stdin. */
export interface PipeProcess extends PtyProcess {
  end(): void;
}

export type PipeSpawn = (
  request: PtyRequest & { onStderr: (data: Uint8Array) => void },
) => PipeProcess;

export const nodePipeSpawn: PipeSpawn = (request) => {
  const [command, ...args] = request.argv;
  const child = spawn(command!, args, { env: request.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => request.onData(new Uint8Array(chunk)));
  child.stderr.on("data", (chunk: Buffer) => request.onStderr(new Uint8Array(chunk)));
  child.stdin.on("error", () => {});
  const exited = new Promise<number>((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
  return {
    pid: child.pid ?? -1,
    exited,
    write: (data) => void child.stdin.write(data),
    end: () => child.stdin.end(),
    resize: () => {},
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        /** Already gone. */
      }
    },
  };
};

interface BunPtyRuntime {
  spawn(
    argv: string[],
    options: {
      env: Record<string, string>;
      terminal: {
        cols: number;
        rows: number;
        name: string;
        data: (terminal: unknown, data: Uint8Array) => void;
      };
    },
  ): {
    pid: number;
    exited: Promise<number>;
    kill(signal?: NodeJS.Signals): void;
    terminal?: { write(data: string | Uint8Array): number; resize(c: number, r: number): void };
  };
}

export const bunPtySpawn: PtySpawn = (request) => {
  const runtime = (globalThis as unknown as { Bun?: BunPtyRuntime }).Bun;
  if (!runtime) throw new Error("the factory broker requires the Bun runtime");
  const child = runtime.spawn(request.argv, {
    env: request.env,
    terminal: {
      cols: request.cols,
      rows: request.rows,
      name: "xterm-256color",
      data: (_terminal, data) => request.onData(data),
    },
  });
  return {
    pid: child.pid,
    exited: child.exited,
    write: (data) => void child.terminal?.write(data),
    resize: (cols, rows) => child.terminal?.resize(cols, rows),
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        /** Already gone. */
      }
    },
  };
};
