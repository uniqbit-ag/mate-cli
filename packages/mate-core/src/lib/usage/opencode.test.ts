import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectOpenCodeUsage } from "./opencode";
import { normalizeUsageRecords } from "./records";
import type { UsageScope } from "./scope";
import { usageWindow } from "./window";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const window = usageWindow(7, new Date("2026-11-07T12:00:00Z"));
const scope: UsageScope = {
  companionPath: os.tmpdir(),
  companionId: "companion",
  capabilities: [],
  fingerprint: "acme",
  repositories: [
    {
      id: "web",
      kind: "working",
      label: "acme/web",
      path: "/acme/web",
      aliases: ["/acme/web"],
      available: true,
    },
  ],
};

test("reads V2 usage scalars read-only, including old sessions and excluding unrelated/fork history", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-db-"));
  const file = path.join(root, "synthetic.db");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,fork_session_id TEXT,time_created INTEGER); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);",
  );
  db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?)").run("acme-old", "/acme/web", null, 0);
  db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?)").run("acme-other", "/other/web", null, 0);
  db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?)").run(
    "acme-fork",
    "/acme/web",
    "acme-old",
    Date.parse("2026-11-07T02:00:00Z"),
  );
  const insert = db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)");
  const data = (time: string) =>
    JSON.stringify({
      model: { id: "acme-model" },
      time: { created: Date.parse(time) },
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      cost: 0.1,
      content: [{ text: "private synthetic content" }],
    });
  for (const [id, session, time] of [
    ["acme-current", "acme-old", "2026-11-07T01:00:00Z"],
    ["acme-unrelated", "acme-other", "2026-11-07T01:00:00Z"],
    ["acme-inherited", "acme-fork", "2026-11-07T01:00:00Z"],
    ["acme-new", "acme-fork", "2026-11-07T03:00:00Z"],
    ["acme-boundary", "acme-old", window.endExclusive],
  ] as const)
    insert.run(id, session, "assistant", 1, Date.parse(time), data(time));
  db.close();
  const result = await collectOpenCodeUsage(scope, window, new AbortController().signal, {
    database: file,
  });
  expect(
    normalizeUsageRecords(scope, window, result.observations)
      .records.map((record) => record.key)
      .sort(),
  ).toEqual(["acme-current", "acme-new"]);
  expect(result.observations[0]!.tokens?.output).toBe(6);
  expect(JSON.stringify(result)).not.toContain("private synthetic content");
  const check = new DatabaseSync(file, { readOnly: true });
  expect(check.prepare("SELECT COUNT(*) AS count FROM session_message").get()).toEqual({
    count: 5,
  });
  check.close();
});

test("attributes messages to the directory active at their position in the session", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-db-"));
  const file = path.join(root, "located.db");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,fork_session_id TEXT,time_created INTEGER); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);",
  );
  db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?)").run("acme-moved", "/acme/api", null, 0);
  db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?)").run("acme-still", "/acme/docs", null, 0);
  const insert = db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)");
  const time = Date.parse("2026-11-07T01:00:00Z");
  const usage = JSON.stringify({ time: { created: time }, tokens: { input: 1, output: 1 } });
  const move = (from: string, to: string) =>
    JSON.stringify({ previous: { location: { directory: from } }, location: { directory: to } });
  insert.run("acme-before", "acme-moved", "assistant", 1, time, usage);
  insert.run(
    "acme-switch-1",
    "acme-moved",
    "location-switched",
    2,
    time,
    move("/acme/web", "/acme/cli"),
  );
  insert.run("acme-between", "acme-moved", "assistant", 3, time, usage);
  insert.run(
    "acme-switch-2",
    "acme-moved",
    "location-switched",
    4,
    time,
    move("/acme/cli", "/acme/api"),
  );
  insert.run("acme-after", "acme-moved", "assistant", 5, time, usage);
  insert.run("acme-unmoved", "acme-still", "assistant", 1, time, usage);
  db.close();
  const result = await collectOpenCodeUsage(scope, window, new AbortController().signal, {
    database: file,
  });
  expect(Object.fromEntries(result.observations.map((row) => [row.key, row.directory]))).toEqual({
    "acme-before": "/acme/web",
    "acme-between": "/acme/cli",
    "acme-after": "/acme/api",
    "acme-unmoved": "/acme/docs",
  });
});

test("a missing database is unavailable and is not created", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-db-"));
  await mkdir(path.join(root, "empty"));
  const result = await collectOpenCodeUsage(scope, window, new AbortController().signal, {
    database: path.join(root, "missing.db"),
  });
  expect(result.sources[0]!.status).toBe("unavailable");
  expect(result.observations).toHaveLength(0);
  expect(existsSync(path.join(root, "missing.db"))).toBe(false);
});

test("a database without the V2 schema is unsupported", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-db-"));
  const file = path.join(root, "legacy.db");
  new DatabaseSync(file).close();
  const result = await collectOpenCodeUsage(scope, window, new AbortController().signal, {
    database: file,
  });
  expect(result.sources[0]!.status).toBe("unsupported");
});
