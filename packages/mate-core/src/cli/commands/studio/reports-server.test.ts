import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createReportStore, REPORT_LIMITS } from "./reports";
import { companionDigest } from "./selection";
import { startStudioServer, type StudioServerOptions } from "./server";
import type { TerminalProcess, TerminalSpawnRequest } from "./terminal";

const ACME = "/companions/acme";
const BETA = "/companions/beta";
const TOKEN = "k".repeat(43);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mate-reports-server-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

function harness(options: Partial<StudioServerOptions> = {}) {
  const spawned: TerminalSpawnRequest[] = [];
  const exits: ((status: number) => void)[] = [];
  const server = startStudioServer(
    {
      collectStudioInventory: async () => ({
        companions: [
          { path: ACME, health: "ready", pairings: [] },
          { path: BETA, health: "ready", pairings: [] },
        ],
      }),
      renderDocument: () => "<!doctype html>",
      launchableAgents: async () => ["claude"],
      reports: createReportStore({ root }),
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
    },
    { invocation: "serve", writable: true, terminal: true, token: TOKEN, ...options },
  );
  const origin = `http://localhost:${server.port}`;
  const cookie = `mate_studio_${server.port}=${TOKEN}`;

  /** Starts a terminal session for a companion and returns its injected env. */
  const session = async (companion: string) => {
    const messages: unknown[] = [];
    const ws = new WebSocket(`ws://localhost:${server.port}/api/terminal`, {
      headers: { origin, cookie },
    } as never);
    ws.onmessage = (event) => {
      if (typeof event.data === "string") messages.push(JSON.parse(event.data));
    };
    await new Promise((resolve) => (ws.onopen = resolve));
    const before = spawned.length;
    ws.send(
      JSON.stringify({
        type: "start",
        agent: "claude",
        companion: companionDigest(companion),
        cols: 80,
        rows: 24,
      }),
    );
    for (let i = 0; i < 40 && spawned.length === before; i += 1) await sleep(10);
    const env = spawned[before]!.env;
    return {
      ws,
      sessionId: (
        messages.find((m) => (m as { type: string }).type === "ready") as
          | { sessionId: string }
          | undefined
      )?.sessionId,
      env,
      url: env.MATE_STUDIO_REPORT_URL!,
      token: env.MATE_STUDIO_REPORT_TOKEN!,
    };
  };

  const publish = (url: string, headers: Record<string, string>, body: BodyInit) =>
    fetch(`${url}/api/reports`, { method: "POST", headers, body });
  const post = (
    s: { url: string; token: string },
    report: unknown = { title: "T", html: "<p>hi</p>" },
  ) => publish(s.url, { authorization: `Bearer ${s.token}` }, JSON.stringify(report));

  return { server, origin, cookie, session, publish, post, spawned };
}

describe("hosted report publishing", () => {
  test("a live session publishes: id and relative path, no url without a public origin", async () => {
    const h = harness();
    try {
      const s = await h.session(ACME);
      expect(s.url).toBe(`http://localhost:${h.server.port}`.replace("localhost", "127.0.0.1"));
      const response = await h.post(s);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: string; path: string; url?: string };
      expect(body.path).toBe(`/studio/reports/${body.id}`);
      expect(body.url).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(root);

      const listed = await fetch(`${h.origin}/api/reports?companion=${companionDigest(ACME)}`, {
        headers: { cookie: h.cookie },
      });
      const list = (await listed.json()) as { reports: { id: string; title: string }[] };
      expect(list.reports.map((r) => r.id)).toEqual([body.id]);
      expect(JSON.stringify(list)).not.toContain(root);
    } finally {
      await h.server.stop();
    }
  });

  test("returns an absolute url only from the configured public origin", async () => {
    const h = harness({ publicOrigin: "https://studio.acme.test" });
    try {
      const s = await h.session(ACME);
      const body = (await (await h.post(s)).json()) as { id: string; url?: string };
      expect(body.url).toBe(`https://studio.acme.test/studio/reports/${body.id}`);
    } finally {
      await h.server.stop();
    }
  });

  test("refuses the cookie, operator token, foreign and ended credentials; stores nothing", async () => {
    const h = harness();
    try {
      const s = await h.session(ACME);
      const json = JSON.stringify({ title: "T", html: "x" });
      const refusals = [
        await h.publish(s.url, { cookie: h.cookie }, json),
        await h.publish(s.url, { authorization: `Bearer ${TOKEN}` }, json),
        await h.publish(s.url, { authorization: "Bearer not-a-session" }, json),
        await h.publish(s.url, {}, json),
      ];
      expect(refusals.map((r) => r.status)).toEqual([401, 401, 401, 401]);

      await fetch(`${h.origin}/api/terminal/sessions/end`, {
        method: "POST",
        headers: { cookie: h.cookie, origin: h.origin },
        body: JSON.stringify({ id: s.sessionId }),
      });
      expect((await h.post(s)).status).toBe(401);

      const listed = await fetch(`${h.origin}/api/reports?companion=${companionDigest(ACME)}`, {
        headers: { cookie: h.cookie },
      });
      expect(((await listed.json()) as { reports: unknown[] }).reports).toEqual([]);
    } finally {
      await h.server.stop();
    }
  });

  test("refuses malformed bodies and bodies over 10 MiB, accepts a large inlined report", async () => {
    const h = harness();
    try {
      const s = await h.session(ACME);
      const auth = { authorization: `Bearer ${s.token}` };
      expect((await h.publish(s.url, auth, "{not json")).status).toBe(400);
      expect((await h.post(s, { title: 1, html: "x" })).status).toBe(400);
      expect((await h.post(s, { title: "t" })).status).toBe(400);

      const over = JSON.stringify({ title: "t", html: "a".repeat(REPORT_LIMITS.uploadBytes) });
      expect((await h.publish(s.url, auth, over)).status).toBe(413);

      const mermaid = "a".repeat(5_575_485);
      expect(
        (await h.post(s, { title: "diagram", html: `<script>${mermaid}</script>` })).status,
      ).toBe(200);
    } finally {
      await h.server.stop();
    }
  });
});

describe("hosted report serving", () => {
  test("serves stored HTML unchanged under the sandbox headers, after the session ends", async () => {
    const h = harness();
    try {
      const s = await h.session(ACME);
      const html = `<p>/Users/acme/repo/src</p><script>1</script>`;
      const { id, path: route } = (await (await h.post(s, { title: "T", html })).json()) as {
        id: string;
        path: string;
      };
      await fetch(`${h.origin}/api/terminal/sessions/end`, {
        method: "POST",
        headers: { cookie: h.cookie, origin: h.origin },
        body: JSON.stringify({ id: s.sessionId }),
      });

      const response = await fetch(`${h.origin}${route}`, { headers: { cookie: h.cookie } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(html);
      const csp = response.headers.get("content-security-policy")!;
      for (const part of [
        "sandbox allow-scripts allow-modals",
        "default-src 'none'",
        "connect-src 'none'",
        "img-src data:",
        "font-src data:",
        "'unsafe-inline'",
      ]) {
        expect(csp).toContain(part);
      }
      expect(csp).not.toContain("allow-same-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(id).toHaveLength(32);
    } finally {
      await h.server.stop();
    }
  });

  test("answers 404 without detail for unknown ids and refuses tokenless reads", async () => {
    const h = harness();
    try {
      const s = await h.session(ACME);
      const { path: route } = (await (await h.post(s)).json()) as { path: string };
      const missing = await fetch(`${h.origin}/studio/reports/${"0".repeat(32)}`, {
        headers: { cookie: h.cookie },
      });
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("not found");
      expect(
        (await fetch(`${h.origin}/studio/reports/..%2Findex`, { headers: { cookie: h.cookie } }))
          .status,
      ).toBe(404);

      const tokenless = await fetch(`${h.origin}${route}`);
      expect(tokenless.status).toBe(401);
      expect(await tokenless.text()).not.toContain("<p>");
      const list = await fetch(`${h.origin}/api/reports?companion=${companionDigest(ACME)}`);
      expect(list.status).toBe(401);
    } finally {
      await h.server.stop();
    }
  });
});

describe("report-published events", () => {
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>, wanted: string) => {
    let text = "";
    const deadline = Date.now() + 1500;
    while (!text.includes(wanted) && Date.now() < deadline) {
      const result = await Promise.race([reader.read(), sleep(200).then(() => null)]);
      if (result === null) continue;
      if (result.done) break;
      text += new TextDecoder().decode(result.value);
    }
    return text;
  };

  test("is sent to pages of that companion only, typed and without paths", async () => {
    const h = harness();
    try {
      const s = await h.session(ACME);
      const open = async (companion: string) =>
        (
          await fetch(
            `${h.origin}/api/vault/changes?companion=${companionDigest(companion)}&scope=reports`,
            { headers: { cookie: h.cookie } },
          )
        ).body!.getReader();
      const acme = await open(ACME);
      const beta = await open(BETA);
      await sleep(50);
      await h.post(s, { title: "Quarterly", html: "x" });

      const received = await read(acme, "report-published");
      const event = JSON.parse(
        received
          .split("\n")
          .find((l) => l.startsWith("data:"))!
          .slice(5),
      );
      expect(event).toMatchObject({ type: "report-published", title: "Quarterly" });
      expect(Object.keys(event).toSorted()).toEqual([
        "companion",
        "createdAt",
        "id",
        "title",
        "type",
      ]);
      expect(received).not.toContain("vault-tree-changed");

      expect(await read(beta, "report-published")).not.toContain("report-published");
      await acme.cancel();
      await beta.cancel();
    } finally {
      await h.server.stop();
    }
  });
});
