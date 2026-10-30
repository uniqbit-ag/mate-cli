/** @test-requires sockets */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { agentCommand, runAttach } from "./attach-client";
import { serveAttach } from "./attach";
import { encodeControl, encodeData, FRAME_CONTROL, FRAME_STDERR, FrameDecoder } from "./frames";
import type { PipeSpawn, PtyRequest, PtySpawn } from "./pty";
import type { WorksetRuntime } from "./runtime";

let dir: string;
let socket: string;
let stop: (() => void) | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-attach-"));
  socket = path.join(dir, "attach.sock");
});

afterEach(() => {
  stop?.();
  stop = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

const SESSION = "acme-session-0001";

function fakeRuntime() {
  const stopped: Array<[string, string]> = [];
  const commands: unknown[] = [];
  const runtime = {
    attachCommand: async (request: { id: string; command: string[]; envNames: string[] }) => {
      commands.push(request);
      if (request.id === "acme-paused")
        throw new (await import("./ids")).FactoryError(
          "Workset acme-paused is paused; resume it first",
        );
      return [
        "docker",
        "exec",
        "--interactive",
        "--tty",
        "workset-" + request.id,
        ...request.command,
      ];
    },
    stopMarked: async (id: string, session: string) => void stopped.push([id, session]),
    dockerEnv: () => ({ DOCKER_HOST: "unix:///run/acme/docker.sock" }),
  } as unknown as WorksetRuntime;
  return { runtime, stopped, commands };
}

/** A PTY that echoes input back and exits when it reads `exit`. */
function fakePty() {
  const spawned: PtyRequest[] = [];
  const resized: Array<[number, number]> = [];
  const killed: string[] = [];
  const spawn: PtySpawn = (request) => {
    spawned.push(request);
    let finish: (status: number) => void = () => {};
    const exited = new Promise<number>((resolve) => (finish = resolve));
    request.onData(new TextEncoder().encode("agent ready\r\n"));
    return {
      pid: 4242,
      exited,
      write: (data) => {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        if (text.includes("exit")) finish(7);
        else request.onData(new TextEncoder().encode(`echo:${text}`));
      },
      resize: (cols, rows) => void resized.push([cols, rows]),
      kill: (signal) => void killed.push(signal),
    };
  };
  return { spawn, spawned, resized, killed };
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries++) await Bun.sleep(10);
}

function collect(client: net.Socket) {
  const decoder = new FrameDecoder();
  const output: string[] = [];
  const controls: Record<string, unknown>[] = [];
  client.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(new Uint8Array(chunk))) {
      if (frame.type === FRAME_CONTROL) controls.push(frame.message);
      else output.push(new TextDecoder().decode(frame.data));
    }
  });
  return { output, controls };
}

const start = (overrides: Record<string, unknown> = {}) =>
  encodeControl({
    type: "start",
    id: "acme-login",
    session: SESSION,
    command: ["mate", "claude", "--", "--yes", "--continue"],
    agent: true,
    cols: 100,
    rows: 30,
    ...overrides,
  });

describe("the broker's attach socket", () => {
  test("runs the agent in a PTY with the credential and marker in that process only", async () => {
    const { runtime, stopped } = fakeRuntime();
    const pty = fakePty();
    stop = serveAttach(socket, {
      runtime,
      credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "acme-token" },
      spawn: pty.spawn,
      env: { PATH: "/usr/bin" },
    }).stop;
    const client = net.connect(socket);
    const seen = collect(client);
    client.write(start());
    await until(() => seen.output.join("").includes("agent ready"));

    const request = pty.spawned[0]!;
    expect(request.argv).toContain("workset-acme-login");
    expect(request.argv.join(" ")).not.toContain("acme-token");
    expect(request.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("acme-token");
    expect(request.env.MATE_FACTORY_SESSION).toBe(SESSION);
    expect(request.env.DOCKER_HOST).toBe("unix:///run/acme/docker.sock");
    expect([request.cols, request.rows]).toEqual([100, 30]);

    client.write(encodeData("hello"));
    client.write(encodeControl({ type: "resize", cols: 120, rows: 40 }));
    await until(() => seen.output.join("").includes("echo:hello") && pty.resized.length > 0);
    expect(pty.resized).toEqual([[120, 40]]);

    client.write(encodeData("exit"));
    await until(() => seen.controls.length > 0 && stopped.length > 0);
    expect(seen.controls).toEqual([{ type: "exit", status: 7 }]);
    expect(stopped).toEqual([["acme-login", SESSION]]);
  });

  test("closing the attach stops the marked processes inside the container", async () => {
    const { runtime, stopped } = fakeRuntime();
    const pty = fakePty();
    stop = serveAttach(socket, { runtime, credential: null, spawn: pty.spawn }).stop;
    const client = net.connect(socket);
    const seen = collect(client);
    client.write(start({ agent: false }));
    await until(() => seen.output.length > 0);
    client.destroy();
    await until(() => stopped.length > 0);
    expect(stopped).toEqual([["acme-login", SESSION]]);
    expect(pty.killed).toEqual(["SIGHUP"]);
  });

  test.each([
    ["an extra field", { user: "root" }, /does not accept user/],
    ["an agent without a credential", {}, /no Workset agent credential/],
    ["a paused Workset", { id: "acme-paused", agent: false }, /paused/],
    ["a size out of range", { cols: 9999 }, /size out of range/],
  ])("refuses %s and starts nothing", async (_name, overrides, reason) => {
    const { runtime, stopped } = fakeRuntime();
    const pty = fakePty();
    stop = serveAttach(socket, { runtime, credential: null, spawn: pty.spawn }).stop;
    const client = net.connect(socket);
    const seen = collect(client);
    client.write(start(overrides));
    await until(() => seen.controls.length > 0);
    expect(String(seen.controls[0]!.reason)).toMatch(reason);
    expect(pty.spawned).toEqual([]);
    await until(() => client.destroyed || client.readableEnded);
    expect(stopped).toEqual([]);
  });
});

describe("the attach helper", () => {
  test("builds the managed launch with the server-built first turn", () => {
    expect(agentCommand("clarify", "Engineers sign in with SSO.")).toEqual([
      "mate",
      "claude",
      "--",
      "--yes",
      "/mate-clarify-intent Engineers sign in with SSO.",
    ]);
    expect(agentCommand("explore", "ignored")).toEqual([
      "mate",
      "claude",
      "--",
      "--yes",
      "/mate-explore-change",
    ]);
    expect(agentCommand("continue", "ignored")).toEqual([
      "mate",
      "claude",
      "--",
      "--yes",
      "--continue",
    ]);
  });

  test("relays the terminal both ways and exits with the agent's status", async () => {
    const { runtime } = fakeRuntime();
    const pty = fakePty();
    stop = serveAttach(socket, {
      runtime,
      credential: { name: "ANTHROPIC_API_KEY", value: "acme-key" },
      spawn: pty.spawn,
    }).stop;
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 90, rows: 20 });
    let written = "";
    output.on("data", (chunk: Buffer) => (written += chunk.toString()));
    const status = runAttach(
      socket,
      { id: "acme-login", session: SESSION, command: ["mate", "claude"] },
      { input, output, error: new PassThrough() },
    );
    await until(() => written.includes("agent ready"));
    input.write("hi");
    await until(() => written.includes("echo:hi"));
    expect([pty.spawned[0]!.cols, pty.spawned[0]!.rows]).toEqual([90, 20]);
    input.write("exit");
    expect(await status).toBe(7);
  });

  test("reports a refusal and exits 1", async () => {
    const { runtime } = fakeRuntime();
    stop = serveAttach(socket, { runtime, credential: null, spawn: fakePty().spawn }).stop;
    const error = new PassThrough();
    let message = "";
    error.on("data", (chunk: Buffer) => (message += chunk.toString()));
    const status = await runAttach(
      socket,
      { id: "acme-login", session: SESSION, command: ["mate", "claude"] },
      {
        input: new PassThrough(),
        output: Object.assign(new PassThrough(), { columns: 80, rows: 24 }),
        error,
      },
    );
    expect(status).toBe(1);
    expect(message).toContain("no Workset agent credential");
  });
});

describe("a non-TTY attach", () => {
  test("streams stdout and stderr apart, closes stdin on eof, and stops on close", async () => {
    const { runtime, stopped } = fakeRuntime();
    const ended: boolean[] = [];
    const written: string[] = [];
    const spawnPipe: PipeSpawn = (request) => {
      request.onData(new TextEncoder().encode("bridge listening"));
      request.onStderr(new TextEncoder().encode("bridge warning"));
      return {
        pid: 4343,
        exited: new Promise<number>(() => {}),
        write: (data) =>
          void written.push(typeof data === "string" ? data : new TextDecoder().decode(data)),
        end: () => void ended.push(true),
        resize: () => {},
        kill: () => {},
      };
    };
    stop = serveAttach(socket, {
      runtime,
      credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "acme-token" },
      spawn: fakePty().spawn,
      spawnPipe,
    }).stop;
    const client = net.connect(socket);
    const decoder = new FrameDecoder();
    const stdout: string[] = [];
    const stderr: string[] = [];
    client.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        if (frame.type === FRAME_STDERR) stderr.push(new TextDecoder().decode(frame.data));
        else if (frame.type !== FRAME_CONTROL) stdout.push(new TextDecoder().decode(frame.data));
      }
    });
    client.write(
      encodeControl({
        type: "start",
        id: "acme-login",
        session: SESSION,
        command: ["bridge"],
        agent: true,
        tty: false,
      }),
    );
    await until(() => stdout.length > 0 && stderr.length > 0);
    expect([stdout.join(""), stderr.join("")]).toEqual(["bridge listening", "bridge warning"]);
    client.write(encodeData("ping"));
    client.write(encodeControl({ type: "eof" }));
    await until(() => ended.length > 0);
    expect(written).toEqual(["ping"]);
    client.destroy();
    await until(() => stopped.length > 0);
    expect(stopped).toEqual([["acme-login", SESSION]]);
  });
});
