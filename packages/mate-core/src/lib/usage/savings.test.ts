import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectUsageSavings } from "./savings";
import { runUsageCommand } from "./source";
import type { UsageScope } from "./scope";
import { usageWindow } from "./window";

const scope: UsageScope = {
  companionPath: os.tmpdir(),
  companionId: "companion",
  fingerprint: "acme",
  capabilities: ["tokensave", "rtk"],
  repositories: [
    {
      id: "web",
      kind: "working",
      label: "acme/web",
      path: "/acme/web",
      aliases: ["/acme/web", "/acme/worktree"],
      available: true,
    },
  ],
};
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("reads scoped event savings for both tools without global totals, pricing or command content", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-savings-"));
  const database = path.join(root, "synthetic.db");
  const db = new DatabaseSync(database);
  db.exec(
    "CREATE TABLE savings_ledger(id INTEGER PRIMARY KEY,ts INTEGER,project_path TEXT,before_tokens INTEGER,after_tokens INTEGER); CREATE TABLE commands(id INTEGER PRIMARY KEY,timestamp TEXT,project_path TEXT,saved_tokens INTEGER,original_cmd TEXT);",
  );
  for (const [id, dir, date] of [
    [1, "/acme/web", "2026-11-07"],
    [2, "/acme/worktree", "2026-11-06"],
    [3, "/other/web", "2026-11-07"],
    [4, "/acme/web", "2026-11-08"],
  ] as const) {
    db.prepare("INSERT INTO savings_ledger VALUES(?,?,?,?,?)").run(
      id,
      Date.parse(date) / 1000,
      dir,
      100,
      20,
    );
    db.prepare("INSERT INTO commands VALUES(?,?,?,?,?)").run(
      id,
      `${date}T01:00:00Z`,
      dir,
      80,
      "private synthetic command",
    );
  }
  db.close();
  for (const name of ["tokensave", "rtk"] as const) {
    const result = await collectUsageSavings(
      name,
      scope,
      usageWindow(7, new Date("2026-11-07T12:00:00Z")),
      new AbortController().signal,
      { database, installed: async () => true },
    );
    expect(result.observations).toHaveLength(2);
    expect(result.observations.map((row) => row.savings?.tokens)).toEqual([80, 80]);
    expect(result.observations[0]!.savings?.cost).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private synthetic command");
  }
});

test("disabled or missing tools do not open ledgers and lifetime-only schemas are unsupported", async () => {
  const window = usageWindow();
  const disabled = await collectUsageSavings(
    "rtk",
    { ...scope, capabilities: [] },
    window,
    new AbortController().signal,
    {
      command: async () => {
        throw new Error("must not run");
      },
    },
  );
  expect(disabled.sources[0]!.status).toBe("disabled");
  const missing = await collectUsageSavings("rtk", scope, window, new AbortController().signal, {
    installed: async () => false,
  });
  expect(missing.sources[0]!.status).toBe("unavailable");
  const unsupported = await collectUsageSavings(
    "rtk",
    scope,
    window,
    new AbortController().signal,
    {
      database: "/acme/synthetic.db",
      installed: async () => true,
      command: async () => JSON.stringify({ failed: "unsupported" }),
    },
  );
  expect(unsupported.sources[0]!.status).toBe("unsupported");
  expect(unsupported.sources[0]!.detail).toContain("schema is unsupported");
  const unavailable = await collectUsageSavings(
    "rtk",
    scope,
    window,
    new AbortController().signal,
    {
      database: "/acme/synthetic.db",
      installed: async () => true,
      command: async () => JSON.stringify({ failed: "unavailable" }),
    },
  );
  expect(unavailable.sources[0]!.detail).toContain("RTK_DB_PATH");
});

test("real savings readers distinguish missing schemas, missing ledgers and invalid databases", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-savings-"));
  const database = path.join(root, "synthetic.db");
  const read = (file = database) =>
    collectUsageSavings("rtk", scope, usageWindow(), new AbortController().signal, {
      database: file,
      installed: async () => true,
    });
  expect((await read()).sources[0]!.status).toBe("unavailable");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE commands(id INTEGER PRIMARY KEY,timestamp TEXT,saved_tokens INTEGER)");
  db.close();
  const unsupported = await read();
  expect(unsupported.sources[0]!.status).toBe("unsupported");
  expect(unsupported.sources[0]!.detail).toContain("missing required columns: project_path");
  const invalid = path.join(root, "invalid.db");
  await writeFile(invalid, "private synthetic content that is not SQLite");
  const broken = await read(invalid);
  expect(broken.sources[0]!.status).toBe("error");
  expect(broken.sources[0]!.detail).toContain("not a SQLite database");
  expect(JSON.stringify(broken)).not.toContain("private synthetic content");
  expect(JSON.stringify(broken)).not.toContain(root);
});

test("locked ledgers are read failures, not unsupported schemas, and can recover", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-savings-"));
  const database = path.join(root, "synthetic.db");
  const db = new DatabaseSync(database);
  db.exec(
    "CREATE TABLE commands(id INTEGER PRIMARY KEY,timestamp TEXT,project_path TEXT,saved_tokens INTEGER); BEGIN EXCLUSIVE;",
  );
  const read = () =>
    collectUsageSavings("rtk", scope, usageWindow(), new AbortController().signal, {
      database,
      installed: async () => true,
    });
  try {
    const locked = await read();
    expect(locked.sources[0]!.status).toBe("error");
    expect(locked.sources[0]!.detail).toContain("locked or busy");
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
  expect((await read()).sources[0]!.status).toBe("empty");
});

test("safe read diagnostics never expose raw SQLite errors or misclassify reader failures", async () => {
  for (const [reason, detail] of [
    ["access", "permissions"],
    ["io", "storage read error"],
    ["read", "could not be read"],
    ["unexpected", "could not be read"],
  ]) {
    const result = await collectUsageSavings(
      "rtk",
      scope,
      usageWindow(),
      new AbortController().signal,
      {
        database: "/acme/synthetic.db",
        installed: async () => true,
        command: async () =>
          JSON.stringify({ failed: "error", reason, message: "private synthetic SQLite error" }),
      },
    );
    expect(result.sources[0]!.status).toBe("error");
    expect(result.sources[0]!.detail).toContain(detail!);
    expect(JSON.stringify(result)).not.toContain("private synthetic");
  }
  const result = await collectUsageSavings(
    "rtk",
    scope,
    usageWindow(),
    new AbortController().signal,
    {
      database: "/acme/synthetic.db",
      installed: async () => true,
      command: async () => JSON.stringify({ unexpected: true }),
    },
  );
  expect(result.sources[0]!.status).toBe("error");
});

test("Node reader preserves error classification and the supported RTK schema", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-savings-"));
  const database = path.join(root, "synthetic.db");
  const read = () =>
    collectUsageSavings("rtk", scope, usageWindow(), new AbortController().signal, {
      database,
      installed: async () => true,
      command: (_executable, args, cwd, signal) => runUsageCommand("node", args, cwd, signal),
    });
  const db = new DatabaseSync(database);
  db.exec(
    "CREATE TABLE commands(id INTEGER PRIMARY KEY,timestamp TEXT,project_path TEXT,saved_tokens INTEGER); BEGIN EXCLUSIVE;",
  );
  try {
    const locked = await read();
    expect(locked.sources[0]!.status).toBe("error");
    expect(locked.sources[0]!.detail).toContain("locked or busy");
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
  expect((await read()).sources[0]!.status).toBe("empty");
  await writeFile(database, "private synthetic invalid SQLite");
  const invalid = await read();
  expect(invalid.sources[0]!.status).toBe("error");
  expect(invalid.sources[0]!.detail).toContain("not a SQLite database");
});

test.each(["rtk", "tokensave"] as const)(
  "reads %s WAL savings without pre-existing sidecars",
  async (name) => {
    root = await mkdtemp(path.join(os.tmpdir(), "acme-savings-"));
    const database = path.join(root, "synthetic.db");
    const db = new DatabaseSync(database);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE commands(id INTEGER PRIMARY KEY,timestamp TEXT,project_path TEXT,saved_tokens INTEGER,original_cmd TEXT); CREATE TABLE savings_ledger(id INTEGER PRIMARY KEY,ts INTEGER,project_path TEXT,before_tokens INTEGER,after_tokens INTEGER)",
    );
    db.exec(
      "INSERT INTO commands VALUES(1,'2026-11-07T01:00:00Z','/acme/web',80,'private synthetic command'); INSERT INTO savings_ledger VALUES(1,1794013200,'/acme/web',100,20)",
    );
    db.close();
    expect(existsSync(`${database}-wal`)).toBe(false);
    expect(existsSync(`${database}-shm`)).toBe(false);
    const before = await readFile(database);
    const executables: string[] = [];
    let firstSqliteCode: number | undefined;
    const result = await collectUsageSavings(
      name,
      scope,
      usageWindow(7, new Date("2026-11-07T12:00:00Z")),
      new AbortController().signal,
      {
        database,
        installed: async () => true,
        command: async (executable, args, cwd, signal) => {
          executables.push(executable);
          const output = await runUsageCommand(executable, args, cwd, signal);
          if (executables.length === 1) firstSqliteCode = JSON.parse(output).sqliteCode;
          return output;
        },
      },
    );
    expect(result.sources[0]!.status).toBe("ok");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.savings?.tokens).toBe(80);
    expect(executables).toEqual(
      firstSqliteCode === 14 ? [process.execPath, "node"] : [process.execPath],
    );
    expect(await readFile(database)).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("private synthetic command");
  },
);

test("Node fallback sees committed WAL records rather than an immutable stale snapshot", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-savings-"));
  const database = path.join(root, "synthetic.db");
  const db = new DatabaseSync(database);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE commands(id INTEGER PRIMARY KEY,timestamp TEXT,project_path TEXT,saved_tokens INTEGER); PRAGMA wal_checkpoint(TRUNCATE)",
  );
  db.exec("INSERT INTO commands VALUES(1,'2026-11-07T01:00:00Z','/acme/web',80)");
  let calls = 0;
  try {
    const result = await collectUsageSavings(
      "rtk",
      scope,
      usageWindow(7, new Date("2026-11-07T12:00:00Z")),
      new AbortController().signal,
      {
        database,
        installed: async () => true,
        command: (executable, args, cwd, signal) => {
          if (++calls === 1)
            return Promise.resolve(
              JSON.stringify({ failed: "error", reason: "access", sqliteCode: 14 }),
            );
          expect(executable).toBe("node");
          return runUsageCommand(executable, args, cwd, signal);
        },
      },
    );
    expect(result.sources[0]!.status).toBe("ok");
    expect(result.observations[0]!.savings?.tokens).toBe(80);
    expect(calls).toBe(2);
  } finally {
    db.close();
  }
});

test("missing Node fallback reports a sanitized runtime diagnostic", async () => {
  const executables: string[] = [];
  const result = await collectUsageSavings(
    "rtk",
    scope,
    usageWindow(),
    new AbortController().signal,
    {
      database: "/acme/synthetic.db",
      installed: async () => true,
      command: async (executable) => {
        executables.push(executable);
        if (executable === "node")
          throw Object.assign(new Error("private synthetic executable path"), { code: "ENOENT" });
        return JSON.stringify({ failed: "error", reason: "access", sqliteCode: 14 });
      },
    },
  );
  expect(executables).toEqual([process.execPath, "node"]);
  expect(result.sources[0]!.status).toBe("error");
  expect(result.sources[0]!.detail).toContain("Node.js 22.19+");
  expect(JSON.stringify(result)).not.toContain("private synthetic");
});

test("only Bun CANTOPEN is retried and Node failures keep their classification", async () => {
  for (const failure of [
    { failed: "unsupported", missing: ["project_path"] },
    { failed: "unavailable" },
    { failed: "error", reason: "locked", sqliteCode: 5 },
    { failed: "error", reason: "access", sqliteCode: 8 },
    { failed: "error", reason: "invalid", sqliteCode: 26 },
  ]) {
    let calls = 0;
    const result = await collectUsageSavings(
      "rtk",
      scope,
      usageWindow(),
      new AbortController().signal,
      {
        database: "/acme/synthetic.db",
        installed: async () => true,
        command: async () => {
          calls++;
          return JSON.stringify(failure);
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.sources[0]!.status).toBe(failure.failed);
  }
  let calls = 0;
  const result = await collectUsageSavings(
    "rtk",
    scope,
    usageWindow(),
    new AbortController().signal,
    {
      database: "/acme/synthetic.db",
      installed: async () => true,
      command: async () =>
        JSON.stringify(
          ++calls === 1
            ? { failed: "error", reason: "access", sqliteCode: 14 }
            : { failed: "error", reason: "locked", sqliteCode: 5 },
        ),
    },
  );
  expect(calls).toBe(2);
  expect(result.sources[0]!.detail).toContain("locked or busy");
});

test.each([1, 2])(
  "cancellation at reader attempt %s never triggers another fallback",
  async (abortAt) => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      collectUsageSavings("rtk", scope, usageWindow(), controller.signal, {
        database: "/acme/synthetic.db",
        installed: async () => true,
        command: async () => {
          calls++;
          if (calls === abortAt) {
            controller.abort(new Error("acme cancelled"));
            if (abortAt === 2) throw controller.signal.reason;
          }
          return JSON.stringify({ failed: "error", reason: "access", sqliteCode: 14 });
        },
      }),
    ).rejects.toThrow("acme cancelled");
    expect(calls).toBe(abortAt);
  },
);
