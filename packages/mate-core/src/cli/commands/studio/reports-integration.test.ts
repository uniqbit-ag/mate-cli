import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { reportDataToDocument } from "../report/adapter";
import { runReportCommand } from "../report/index";
import { REPORT_DOCUMENT_VERSION, type ReportData } from "../report/types";
import { createReportStore, REPORT_LIMITS } from "./reports";
import { companionDigest } from "./selection";
import { startStudioServer } from "./server";
import type { TerminalProcess, TerminalSpawnRequest } from "./terminal";

const ACME = "/companions/acme";
const TOKEN = "k".repeat(43);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mate-reports-integration-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** A real Studio server whose terminal session's environment is handed to a real `mate report` run. */
async function studioSession() {
  const spawned: TerminalSpawnRequest[] = [];
  const server = startStudioServer(
    {
      collectStudioInventory: async () => ({
        companions: [{ path: ACME, health: "ready", pairings: [] }],
      }),
      renderDocument: () => "<!doctype html>",
      launchableAgents: async () => ["claude"],
      reports: createReportStore({ root }),
      terminal: {
        spawn: (request): TerminalProcess => {
          spawned.push(request);
          return {
            pid: 999_999,
            exited: new Promise(() => {}),
            write() {},
            resize() {},
            close() {},
          };
        },
        signalGroup: () => {},
        limits: { termGraceMs: 10, reapMs: 10 } as never,
      },
    },
    { invocation: "serve", writable: true, terminal: true, token: TOKEN },
  );
  const origin = `http://localhost:${server.port}`;
  const cookie = `mate_studio_${server.port}=${TOKEN}`;
  const ws = new WebSocket(`ws://localhost:${server.port}/api/terminal`, {
    headers: { origin, cookie },
  } as never);
  await new Promise((resolve) => (ws.onopen = resolve));
  ws.send(
    JSON.stringify({
      type: "start",
      agent: "claude",
      companion: companionDigest(ACME),
      cols: 80,
      rows: 24,
    }),
  );
  for (let i = 0; i < 40 && spawned.length === 0; i += 1) await sleep(10);
  return { server, origin, cookie, env: spawned[0]!.env };
}

/** Runs `mate report --input` with the session's environment and returns what it printed. */
async function report(env: Record<string, string>, input: unknown) {
  const logs = spyOn(console, "log").mockImplementation(() => {});
  const warns = spyOn(console, "warn").mockImplementation(() => {});
  const saved = {
    url: process.env.MATE_STUDIO_REPORT_URL,
    token: process.env.MATE_STUDIO_REPORT_TOKEN,
  };
  process.env.MATE_STUDIO_REPORT_URL = env.MATE_STUDIO_REPORT_URL;
  process.env.MATE_STUDIO_REPORT_TOKEN = env.MATE_STUDIO_REPORT_TOKEN;
  try {
    await runReportCommand(["--input", "report.json"], {
      ensureUnambiguousCompanion: async () => true,
      readInput: async () => JSON.stringify(input),
      writeTemporaryReport: async () => {
        throw new Error("a hosted report must not touch the temp dir");
      },
    });
    return { logs: logs.mock.calls.map(String), warns: warns.mock.calls.map(String) };
  } finally {
    for (const [key, value] of [
      ["MATE_STUDIO_REPORT_URL", saved.url],
      ["MATE_STUDIO_REPORT_TOKEN", saved.token],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    logs.mockRestore();
    warns.mockRestore();
  }
}

const reportId = (logs: string[]) => /\(report ([0-9a-f]{32})\)/.exec(logs.join("\n"))?.[1];

describe("Studio terminal session running `mate report --input`", () => {
  test("hosts a diagram report under the cap, renders it with its runtime and print control", async () => {
    const session = await studioSession();
    try {
      const { logs, warns } = await report(session.env, {
        version: REPORT_DOCUMENT_VERSION,
        title: "Flow",
        generatedAt: "2026-01-01T00:00:00Z",
        metadata: [],
        summary: [],
        sections: [
          { id: "flow", title: "Flow", type: "diagram", mermaid: "flowchart LR\n  A --> B" },
        ],
      });
      expect(warns).toEqual([]);
      const id = reportId(logs);
      expect(id).toBeDefined();
      expect(logs.join("\n")).not.toContain(session.env.MATE_STUDIO_REPORT_TOKEN!);
      expect(logs.join("\n")).not.toContain("127.0.0.1");

      const served = await fetch(`${session.origin}/studio/reports/${id}`, {
        headers: { cookie: session.cookie },
      });
      const html = await served.text();
      expect(served.status).toBe(200);
      expect(Buffer.byteLength(html)).toBeGreaterThan(5_000_000);
      expect(Buffer.byteLength(html)).toBeLessThan(REPORT_LIMITS.uploadBytes);
      expect(html).toContain("flowchart LR");
      expect(html).toContain('onclick="window.print()"');
      expect(served.headers.get("content-security-policy")).toContain("allow-modals");
    } finally {
      await session.server.stop();
    }
  });

  test("keeps a usage report's repository paths intact for an authorized viewer", async () => {
    const session = await studioSession();
    try {
      const data: ReportData = {
        days: 7,
        generatedAt: "2026-01-01T00:00:00Z",
        workingRepoPath: "/Users/acme/work/app",
        companionRepoPath: "/Users/acme/companions/app",
        activeAgents: [],
        enabledCapabilities: [],
        spending: [],
        savings: [],
        toolStatus: [],
        totalSpending: 0,
        totalSavings: 0,
        netSpend: 0,
      } as unknown as ReportData;
      const { logs } = await report(session.env, reportDataToDocument(data));
      const id = reportId(logs)!;

      const served = await fetch(`${session.origin}/studio/reports/${id}`, {
        headers: { cookie: session.cookie },
      });
      const html = await served.text();
      expect(html).toContain("/Users/acme/work/app");
      expect(html).toContain("/Users/acme/companions/app");

      const list = await fetch(`${session.origin}/api/reports?companion=${companionDigest(ACME)}`, {
        headers: { cookie: session.cookie },
      });
      expect(await list.text()).not.toContain("/Users/acme");
    } finally {
      await session.server.stop();
    }
  });
});
