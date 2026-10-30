/** @test-requires sockets */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { serveAttach } from "./attach";
import type { FactoryClient } from "./client";
import type { PipeSpawn, PtyRequest } from "./pty";
import type { WorksetRuntime } from "./runtime";
import { createWorksetSandbox } from "./sandbox";

const WORKTREE = "/var/lib/mate-factory/worktrees/acme-login";
const HOME = "/home/mate";

let dir: string;
let socket: string;
let stop: (() => void) | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-sandbox-"));
  socket = path.join(dir, "attach.sock");
});

afterEach(() => {
  stop?.();
  stop = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A broker client whose `exec` keeps files in a map, the way the container's shell would. */
function fakeClient() {
  const files = new Map<string, Uint8Array>();
  const execs: Array<{ command: string[]; agent?: boolean; stdin?: Uint8Array }> = [];
  const client = {
    exec: async (request: { command: string[]; agent?: boolean; stdin?: Uint8Array }) => {
      execs.push(request);
      const [, , script, , file] = request.command;
      if (script?.includes("base64")) {
        const content = files.get(file!);
        return content
          ? { status: 0, stdout: Buffer.from(content).toString("base64"), stderr: "" }
          : { status: 3, stdout: "", stderr: "" };
      }
      if (script?.includes("cat >")) {
        files.set(file!, request.stdin!);
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: `ran ${request.command.at(-1)}`, stderr: "" };
    },
    address: async () => "172.18.0.5",
  } as unknown as FactoryClient;
  return { client, files, execs };
}

function sandboxFor(client: FactoryClient, extra: { agentSpawns?: boolean } = {}) {
  let n = 0;
  return createWorksetSandbox({
    ...extra,
    id: "acme-login",
    worktree: WORKTREE,
    home: HOME,
    client,
    attachSocket: socket,
    bridgePort: 7681,
    sessionId: () => `acme-bridge-${String(++n).padStart(4, "0")}`,
  });
}

describe("the Workset sandbox", () => {
  test("runs commands in the worktree through broker exec", async () => {
    const { client, execs } = fakeClient();
    const result = await sandboxFor(client).run({ command: "git status", env: { CI: "1" } });
    expect(result).toEqual({
      exitCode: 0,
      stdout: `ran cd '${WORKTREE}' && git status`,
      stderr: "",
    });
    expect(execs[0]).toEqual({
      id: "acme-login",
      command: ["env", "CI=1", "bash", "-c", `cd '${WORKTREE}' && git status`],
    });
  });

  test("runs the harness's package-manager commands with Bun", async () => {
    const { client, execs } = fakeClient();
    await sandboxFor(client).run({
      command: "pnpm install --frozen-lockfile --store-dir .pnpm-store",
      workingDirectory: `${HOME}/.harness-bootstrap/claude-code`,
    });
    const script = execs[0]!.command.at(-1)!;
    expect(script).toContain("ln -sfn /opt/mate/harness-bridge/node_modules node_modules");
    expect(script).toContain("else bun install --frozen-lockfile; fi");
    expect(script).not.toContain("pnpm");
  });

  test("writes and reads files, binary-safe, and reports a missing file as null", async () => {
    const { client } = fakeClient();
    const sandbox = sandboxFor(client);
    const bytes = new Uint8Array([0, 255, 10, 65]);
    await sandbox.writeBinaryFile({ path: "data/blob.bin", content: bytes });
    expect(await sandbox.readBinaryFile({ path: `${WORKTREE}/data/blob.bin` })).toEqual(bytes);
    await sandbox.writeTextFile({
      path: `${HOME}/.agent-runs/state.txt`,
      content: "one\ntwo\nthree",
    });
    expect(
      await sandbox.readTextFile({
        path: `${HOME}/.agent-runs/state.txt`,
        startLine: 2,
        endLine: 3,
      }),
    ).toBe("two\nthree");
    expect(await sandbox.readTextFile({ path: "missing.txt" })).toBeNull();
  });

  test.each([
    "/etc/passwd",
    "../acme-other/file",
    "/var/lib/mate-factory/repos/acme__web/.git/config",
  ])("refuses %s outside the worktree and home", async (target) => {
    const { client, execs } = fakeClient();
    await expect(sandboxFor(client).readTextFile({ path: target })).rejects.toThrow(/outside/);
    expect(execs).toEqual([]);
  });

  test("a command asking for the credential is started with agent: true, never with the value", async () => {
    const { client, execs } = fakeClient();
    await sandboxFor(client).run({
      command: "claude --version",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "placeholder-from-host", PATH: "/usr/bin" },
    });
    expect(execs[0]!.agent).toBe(true);
    expect(JSON.stringify(execs[0])).not.toContain("placeholder-from-host");
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("resolves the bridge port to the container's inner-network address", async () => {
    const { client } = fakeClient();
    const sandbox = sandboxFor(client);
    expect(await sandbox.getPortEndpoint({ port: 7681, protocol: "ws" })).toEqual({
      url: "ws://172.18.0.5:7681",
    });
    await expect(sandbox.getPortEndpoint({ port: 22 })).rejects.toThrow(/not exposed/);
  });

  test.each([
    ["a credential variable", {}, { ANTHROPIC_API_KEY: "placeholder", BRIDGE_PORT: "7681" }],
    ["agentSpawns and no credential variable", { agentSpawns: true }, { BRIDGE_PORT: "7681" }],
  ])(
    "spawns the bridge over the non-TTY attach with the credential requested from the broker, given %s",
    async (_name, extra, env) => {
      const spawned: Array<PtyRequest & { onStderr: (data: Uint8Array) => void }> = [];
      let finish: (status: number) => void = () => {};
      const spawnPipe: PipeSpawn = (request) => {
        spawned.push(request);
        request.onData(new TextEncoder().encode("bridge ready"));
        return {
          pid: 1,
          exited: new Promise<number>((resolve) => (finish = resolve)),
          write: () => {},
          end: () => {},
          resize: () => {},
          kill: () => {},
        };
      };
      const stopped: string[] = [];
      const runtime = {
        attachCommand: async (request: {
          command: string[];
          tty?: boolean;
          envNames: string[];
        }) => ["docker", "exec", String(request.tty), ...request.envNames, ...request.command],
        stopMarked: async (_id: string, session: string) => void stopped.push(session),
        dockerEnv: () => ({}),
      } as unknown as WorksetRuntime;
      stop = serveAttach(socket, {
        runtime,
        credential: { name: "ANTHROPIC_API_KEY", value: "acme-key" },
        spawnPipe,
      }).stop;

      const sandbox = sandboxFor(fakeClient().client, extra);
      const bridge = await sandbox.spawn({
        command: "node /opt/mate/harness-bridge/index.js",
        env,
      });
      const reader = bridge.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("bridge ready");
      expect(spawned[0]!.argv.slice(0, 4)).toEqual([
        "docker",
        "exec",
        "false",
        "ANTHROPIC_API_KEY",
      ]);
      expect(spawned[0]!.env.ANTHROPIC_API_KEY).toBe("acme-key");
      expect(spawned[0]!.argv.join(" ")).not.toContain("placeholder");
      expect(spawned[0]!.argv).toContain("BRIDGE_PORT=7681");
      expect(spawned[0]!.argv.at(-1)).toEndWith("&& bun /opt/mate/harness-bridge/index.js");

      finish(0);
      expect(await bridge.wait()).toEqual({ exitCode: 0 });
      for (let tries = 0; tries < 100 && stopped.length === 0; tries++) await Bun.sleep(10);
      expect(stopped).toEqual(["acme-bridge-0001"]);
    },
  );
});
