import { describe, expect, test } from "bun:test";

import { companionDigest } from "./selection";
import { startStudioServer, type StudioServerDeps } from "./server";
import type { TerminalProcess, TerminalSpawnRequest } from "./terminal";

const ACME = "/companions/acme";
const TOKEN = "k".repeat(43);

function harness() {
  const spawned: TerminalSpawnRequest[] = [];
  const exits: ((status: number) => void)[] = [];
  const deps: StudioServerDeps = {
    collectStudioInventory: async () => ({
      companions: [{ path: ACME, health: "ready", pairings: [] }],
    }),
    renderDocument: (page) => JSON.stringify(page.terminal),
    launchableAgents: async () => ["claude", "opencode"],
    terminal: {
      spawn: (request): TerminalProcess => {
        spawned.push(request);
        let resolve!: (status: number) => void;
        const exited = new Promise<number>((r) => (resolve = r));
        exits.push(resolve);
        return { pid: 999_999, exited, write() {}, resize() {}, close() {} };
      },
      signalGroup: (_pid, signal) => {
        if (signal === "SIGKILL") for (const exit of exits) exit(137);
      },
      limits: { termGraceMs: 10, reapMs: 10 } as never,
    },
  };
  const server = startStudioServer(deps, {
    invocation: "serve",
    writable: true,
    terminal: true,
    token: TOKEN,
  });
  const origin = `http://localhost:${server.port}`;
  const cookie = `mate_studio_${server.port}=${TOKEN}`;
  return { server, spawned, origin, cookie };
}

function open(
  url: string,
  headers: Record<string, string>,
): Promise<{ ws: WebSocket; messages: unknown[]; status: "open" | "error" }> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const ws = new WebSocket(url, { headers } as never);
    ws.onmessage = (event) => {
      if (typeof event.data === "string") messages.push(JSON.parse(event.data));
    };
    ws.onopen = () => resolve({ ws, messages, status: "open" });
    ws.onerror = () => resolve({ ws, messages, status: "error" });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const START = JSON.stringify({
  type: "start",
  agent: "claude",
  companion: companionDigest(ACME),
  cols: 80,
  rows: 24,
});

describe("terminal endpoint", () => {
  test.each([
    {
      name: "a foreign origin",
      headers: (h: ReturnType<typeof harness>) => ({
        origin: "https://evil.test",
        cookie: h.cookie,
      }),
    },
    { name: "a missing token", headers: (h: ReturnType<typeof harness>) => ({ origin: h.origin }) },
    {
      name: "a rebinding host",
      headers: (h: ReturnType<typeof harness>) => ({
        origin: h.origin,
        cookie: h.cookie,
        host: "rebind.acme.test",
      }),
    },
  ])("refuses $name before spawning", async ({ headers }) => {
    const h = harness();
    try {
      const { status } = await open(`ws://localhost:${h.server.port}/api/terminal`, headers(h));
      expect(status).toBe("error");
      expect(h.spawned).toHaveLength(0);
    } finally {
      await h.server.stop();
    }
  });

  test("starts a session, lists it, ends it, and stops every session with Studio", async () => {
    const h = harness();
    try {
      const { ws, messages, status } = await open(`ws://localhost:${h.server.port}/api/terminal`, {
        origin: h.origin,
        cookie: h.cookie,
      });
      expect(status).toBe("open");
      ws.send(START);
      for (let i = 0; i < 40 && messages.length === 0; i += 1) await sleep(10);
      expect(messages[0]).toMatchObject({ type: "ready", companionPath: ACME });
      expect(h.spawned[0]!.env.MATE_ARTIFACT_PATH).toBe(ACME);

      const listed = await fetch(`${h.origin}/api/terminal/sessions`, {
        headers: { cookie: h.cookie },
      });
      const { sessions } = (await listed.json()) as {
        sessions: { id: string; attached: boolean }[];
      };
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.attached).toBe(true);

      expect((await fetch(`${h.origin}/api/terminal/sessions`)).status).toBe(401);
      const foreignEnd = await fetch(`${h.origin}/api/terminal/sessions/end`, {
        method: "POST",
        headers: { cookie: h.cookie, origin: "https://evil.test" },
        body: JSON.stringify({ id: sessions[0]!.id }),
      });
      expect(foreignEnd.status).toBe(403);

      ws.close();
      await sleep(30);
      const detached = (await (
        await fetch(`${h.origin}/api/terminal/sessions`, { headers: { cookie: h.cookie } })
      ).json()) as {
        sessions: { attached: boolean }[];
      };
      expect(detached.sessions[0]!.attached).toBe(false);

      const second = await open(`ws://localhost:${h.server.port}/api/terminal`, {
        origin: h.origin,
        cookie: h.cookie,
      });
      second.ws.send(START);
      await sleep(30);
      const ended = await fetch(`${h.origin}/api/terminal/sessions/end`, {
        method: "POST",
        headers: { cookie: h.cookie, origin: h.origin },
        body: JSON.stringify({ id: sessions[0]!.id }),
      });
      expect(ended.status).toBe(200);
      second.ws.close();
    } finally {
      await h.server.stop();
    }
    expect(h.server).toBeDefined();
  });

  test("the page names the launch target only with the terminal", async () => {
    const h = harness();
    try {
      const page = await fetch(`${h.origin}/?companion=${companionDigest(ACME)}`, {
        headers: { cookie: h.cookie },
      });
      expect(JSON.parse(await page.text())).toEqual({
        pinned: false,
        target: { path: ACME, digest: companionDigest(ACME) },
        agents: ["claude", "opencode"],
      });
      const asset = await fetch(`${h.origin}/studio/terminal/xterm.js`, {
        headers: { cookie: h.cookie },
      });
      expect(asset.status).toBe(200);
      expect(
        await fetch(`${h.origin}/studio/terminal/../../package.json`, {
          headers: { cookie: h.cookie },
        }).then((r) => r.status),
      ).toBe(404);
    } finally {
      await h.server.stop();
    }
    const plain = startStudioServer(
      {
        renderDocument: (page) => JSON.stringify(page.terminal),
        collectStudioInventory: async () => ({ companions: [] }),
      },
      {},
    );
    try {
      expect(await (await fetch(plain.url)).text()).toBe("null");
      expect((await fetch(`${plain.url}/studio/terminal/xterm.js`)).status).toBe(404);
      expect((await fetch(`${plain.url}/api/terminal/sessions`)).status).toBe(404);
    } finally {
      await plain.stop();
    }
  });
});
