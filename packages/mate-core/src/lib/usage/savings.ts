import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { nonnegative, type UsageObservation } from "./records";
import { resolveRtkDatabase } from "./rtk-database";
import { repositoryForPath, type UsageScope } from "./scope";
import { runUsageCommand, sourceResult, type UsageCollection, type UsageCommand } from "./source";
import type { UsageWindow } from "./types";

const SAVINGS_READER = String.raw`
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
const [file, source, start, end] = process.argv.slice(1);
let db;
try {
  statSync(file);
  db = new DatabaseSync(file, { readOnly: true });
  const table = source === 'tokensave' ? 'savings_ledger' : 'commands';
  const required = source === 'tokensave'
    ? ['id', 'ts', 'project_path', 'before_tokens', 'after_tokens']
    : ['id', 'timestamp', 'project_path', 'saved_tokens'];
  const columns = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name));
  const missing = required.filter(column => !columns.has(column));
  if (missing.length) {
    console.log(JSON.stringify({ failed: 'unsupported', missing }));
  } else {
    const sql = source === 'tokensave'
      ? "SELECT id,ts*1000 AS timestamp,project_path AS directory,MAX(before_tokens-after_tokens,0) AS tokens FROM savings_ledger WHERE ts>=? AND ts<? ORDER BY id LIMIT 100001"
      : "SELECT id,CAST(unixepoch(timestamp) AS INTEGER)*1000 AS timestamp,project_path AS directory,saved_tokens AS tokens FROM commands WHERE unixepoch(timestamp)>=? AND unixepoch(timestamp)<? ORDER BY id LIMIT 100001";
    console.log(JSON.stringify({ rows: db.prepare(sql).all(Date.parse(start)/1000,Date.parse(end)/1000) }));
  }
} catch (error) {
  const code = typeof error.errcode === 'number' ? error.errcode & 255 : undefined;
  const reason = code === 5 || code === 6 ? 'locked'
    : code === 3 || code === 8 || code === 14 || code === 23 || error.code === 'EACCES' || error.code === 'EPERM' ? 'access'
    : code === 11 || code === 26 ? 'invalid'
    : code === 10 ? 'io' : 'read';
  console.log(JSON.stringify({ failed: error.code === 'ENOENT' ? 'unavailable' : 'error', reason, sqliteCode: code }));
}
finally { db?.close(); }
`;

async function installed(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- stop at the first executable
      await access(
        path.join(dir, process.platform === "win32" ? `${name}.exe` : name),
        constants.X_OK,
      );
      return true;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return false;
}

interface SavingsReaderResult {
  rows?: { id: number; timestamp: number; directory: string; tokens: number }[];
  failed?: string;
  reason?: string;
  sqliteCode?: number;
  missing?: string[];
}

function savingsFailure(
  scope: UsageScope,
  name: "tokensave" | "rtk",
  data: SavingsReaderResult,
): UsageCollection {
  const errors: Record<string, string> = {
    locked:
      "Savings ledger is locked or busy. Retry Refresh after the current RTK/TokenSave write finishes.",
    access:
      "Savings ledger could not be opened read-only. Check file and parent-directory permissions.",
    invalid:
      "Savings ledger is corrupt or is not a SQLite database. Check the configured ledger path; source data was not changed.",
    io: "Savings ledger encountered a storage read error. Check local storage and retry Refresh.",
    read: "Savings ledger could not be read. Retry Refresh; source data was not changed.",
    runtime:
      "Bun could not open this savings ledger and the Node.js fallback could not run. Ensure Node.js 22.19+ is available, then retry Refresh.",
  };
  const missing = data.missing?.filter((column) =>
    [
      "id",
      "ts",
      "timestamp",
      "project_path",
      "before_tokens",
      "after_tokens",
      "saved_tokens",
    ].includes(column),
  );

  if (data.failed === "unavailable") {
    const detail =
      name === "rtk"
        ? "No RTK ledger found. Run commands through RTK, or check RTK_DB_PATH / tracking.database_path."
        : "No local savings ledger found.";
    return sourceResult(scope, name, "unavailable", [], detail);
  }
  if (data.failed === "unsupported") {
    const columns = missing?.length ? ` (missing required columns: ${missing.join(", ")})` : "";
    return sourceResult(
      scope,
      name,
      "unsupported",
      [],
      `Savings ledger schema is unsupported${columns}; source data was not changed.`,
    );
  }
  const reason = data.reason ?? "read";
  const detail = Object.hasOwn(errors, reason) ? errors[reason] : errors.read;
  return sourceResult(scope, name, "error", [], detail);
}

/** Read ledgers directly: the tools' report commands may migrate state or refresh pricing. */
export async function collectUsageSavings(
  name: "tokensave" | "rtk",
  scope: UsageScope,
  window: UsageWindow,
  signal: AbortSignal,
  options: {
    database?: string;
    command?: UsageCommand;
    installed?: (name: string) => Promise<boolean>;
  } = {},
): Promise<UsageCollection> {
  if (!scope.capabilities.includes(name)) return sourceResult(scope, name, "disabled");
  if (!(await (options.installed ?? installed)(name)))
    return sourceResult(scope, name, "unavailable", [], "Local tool is not installed");
  let file: string;
  try {
    file =
      options.database ??
      (name === "tokensave"
        ? path.join(os.homedir(), ".tokensave", "global.db")
        : await resolveRtkDatabase());
  } catch {
    return sourceResult(
      scope,
      name,
      "error",
      [],
      "RTK configuration could not be read. Check config.toml or RTK_DB_PATH.",
    );
  }
  try {
    const command = options.command ?? runUsageCommand;
    const args = [
      "--input-type=module",
      "--eval",
      SAVINGS_READER,
      file,
      name,
      window.start,
      window.endExclusive,
    ];
    let data = JSON.parse(
      await command(process.execPath, args, scope.companionPath, signal),
    ) as SavingsReaderResult;
    // Bun can reject read-only WAL ledgers without sidecars; Node handles their coordination.
    if (process.versions.bun && data.failed === "error" && data.sqliteCode === 14) {
      signal.throwIfAborted();
      try {
        data = JSON.parse(
          await command("node", args, scope.companionPath, signal),
        ) as SavingsReaderResult;
      } catch {
        signal.throwIfAborted();
        return savingsFailure(scope, name, { failed: "error", reason: "runtime" });
      }
    }
    if (!Array.isArray(data.rows)) return savingsFailure(scope, name, data);
    const observations: UsageObservation[] = data.rows.slice(0, 100_000).flatMap((row) => {
      if (
        typeof row.directory !== "string" ||
        !repositoryForPath(scope, row.directory) ||
        !Number.isFinite(row.timestamp)
      )
        return [];
      return [
        {
          key: String(row.id),
          source: name,
          directory: row.directory,
          timestamp: new Date(row.timestamp).toISOString(),
          model: "savings",
          savings: { tokens: nonnegative(row.tokens), calls: 1 },
        },
      ];
    });
    const partial = data.rows.length > 100_000 || (name === "rtk" && window.days > 90);
    return sourceResult(
      scope,
      name,
      observations.length ? "ok" : "empty",
      observations,
      partial ? "Local ledger limits or retention may leave this window incomplete" : undefined,
      partial,
    );
  } catch {
    signal.throwIfAborted();
    return sourceResult(scope, name, "error", [], "Local savings ledger could not be read");
  }
}
