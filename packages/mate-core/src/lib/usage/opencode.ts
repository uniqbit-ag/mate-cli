import os from "node:os";
import path from "node:path";

import { nonnegative, type UsageObservation } from "./records";
import type { UsageScope } from "./scope";
import { runUsageCommand, sourceResult, type UsageCollection, type UsageCommand } from "./source";
import type { UsageWindow } from "./types";

/** V2 session_message/session_v2 schema; extract usage scalars, never message bodies. */
const OPENCODE_USAGE_READER = String.raw`
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
const [file, start, end] = process.argv.slice(1);
let db;
try {
  statSync(file);
  db = new DatabaseSync(file, { readOnly: true });
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
  if (!tables.has("session_v2") || !tables.has("session_message")) {
    console.log(JSON.stringify({ unsupported: true }));
  } else {
    const data = "CASE WHEN json_valid(m.data) THEN m.data ELSE '{}' END";
    const field = (key) => "json_extract(" + data + ", '$." + key + "')";
    const time = "coalesce(" + field("time.created") + ", m.time_created)";
    // Read location switches once; per-row subqueries are quadratic without an index.
    const switches = new Map();
    for (const row of db.prepare(
      "SELECT session_id AS session, seq, json_extract(data, '$.location.directory') AS directory, " +
      "json_extract(data, '$.previous.location.directory') AS previous FROM session_message " +
      "WHERE type='location-switched' AND json_valid(data) AND seq IS NOT NULL ORDER BY session_id, seq"
    ).all()) {
      if (!switches.has(row.session)) switches.set(row.session, []);
      switches.get(row.session).push(row);
    }
    // The last switch at or before a message names its directory; before any switch, the
    // first later switch's previous directory does, then the session's own.
    const directory = (session, seq, fallback) => {
      if (seq === null) return fallback;
      let before, after;
      for (const row of switches.get(session) ?? []) {
        if (row.seq <= seq) before = row;
        else {
          after = row;
          break;
        }
      }
      return before?.directory ?? after?.previous ?? fallback;
    };
    const rows = db.prepare(
      "SELECT m.id, m.session_id AS session, m.seq, s.directory AS sessionDirectory, " + time + " AS timestamp, " +
      field("model.id") + " AS model, " + field("tokens.input") + " AS input, " +
      field("tokens.output") + " AS output, " + field("tokens.reasoning") + " AS reasoning, " +
      field("tokens.cache.read") + " AS cacheRead, " + field("tokens.cache.write") + " AS cacheWrite, " +
      field("cost") + " AS cost FROM session_message m JOIN session_v2 s ON s.id=m.session_id " +
      "WHERE m.type IN ('assistant','compaction') AND " + field("tokens") + " IS NOT NULL AND " +
      time + ">=? AND " + time + "<? AND (s.fork_session_id IS NULL OR " + field("time.created") + ">=s.time_created) " +
      "ORDER BY m.id LIMIT 100001"
    ).all(Date.parse(start), Date.parse(end)).map(({ session, seq, sessionDirectory, ...row }) =>
      ({ ...row, directory: directory(session, seq, sessionDirectory) }));
    console.log(JSON.stringify({ rows }));
  }
} catch (error) {
  const code = typeof error.errcode === 'number' ? error.errcode & 255 : undefined;
  const failed = error.code === 'ENOENT' ? 'unavailable' : code === 11 || code === 26 ? 'unsupported' : 'error';
  console.log(JSON.stringify({ failed, sqliteCode: code }));
} finally { db?.close(); }
`;

interface OpenCodeReaderResult {
  rows?: OpenCodeUsageRow[];
  unsupported?: boolean;
  failed?: "unavailable" | "unsupported" | "error";
  sqliteCode?: number;
}

interface OpenCodeUsageRow {
  id: string;
  timestamp: number;
  directory: string;
  model: string | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cost: number | null;
}

const READER_FAILURES = {
  unavailable: "No local OpenCode database found",
  error: "Local OpenCode usage could not be read",
  unsupported: "Local OpenCode usage storage is unsupported",
} as const;

export async function collectOpenCodeUsage(
  scope: UsageScope,
  window: UsageWindow,
  signal: AbortSignal,
  options: { database?: string; command?: UsageCommand } = {},
): Promise<UsageCollection> {
  const database =
    options.database ??
    process.env.OPENCODE_DB ??
    path.join(
      process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
      "opencode",
      "opencode.db",
    );
  try {
    const args = [
      "--input-type=module",
      "--eval",
      OPENCODE_USAGE_READER,
      database,
      window.start,
      window.endExclusive,
    ];
    const output = await (options.command ?? runUsageCommand)(
      process.execPath,
      args,
      scope.companionPath,
      signal,
    );
    let data = JSON.parse(output) as OpenCodeReaderResult;
    // Bun can reject read-only WAL databases without sidecars; Node handles their coordination.
    if (process.versions.bun && data.failed === "error" && data.sqliteCode === 14) {
      signal.throwIfAborted();
      try {
        data = JSON.parse(
          await (options.command ?? runUsageCommand)("node", args, scope.companionPath, signal),
        ) as OpenCodeReaderResult;
      } catch {
        signal.throwIfAborted();
      }
    }
    if (!Array.isArray(data.rows)) {
      const status =
        data.failed === "unavailable" || data.failed === "error" ? data.failed : "unsupported";
      return sourceResult(scope, "opencode", status, [], READER_FAILURES[status]);
    }
    const observations: UsageObservation[] = data.rows.slice(0, 100_000).flatMap((row) => {
      if (
        typeof row.id !== "string" ||
        typeof row.directory !== "string" ||
        !Number.isFinite(row.timestamp)
      )
        return [];
      const outputTokens = nonnegative(row.output);
      const reasoning = nonnegative(row.reasoning);
      const cost = nonnegative(row.cost);
      return [
        {
          key: row.id,
          source: "opencode" as const,
          directory: row.directory,
          timestamp: new Date(row.timestamp).toISOString(),
          model: row.model ?? "unknown",
          tokens: {
            input: nonnegative(row.input),
            output: outputTokens === null ? null : outputTokens + (reasoning ?? 0),
            cacheRead: nonnegative(row.cacheRead),
            cacheWrite: nonnegative(row.cacheWrite),
          },
          ...(cost !== null
            ? { cost: { amount: cost, currency: "USD", basis: "reported" as const } }
            : {}),
        },
      ];
    });
    return sourceResult(
      scope,
      "opencode",
      observations.length ? "ok" : "empty",
      observations,
      data.rows.length > 100_000 ? "Usage record limit reached" : undefined,
      data.rows.length > 100_000,
    );
  } catch (error) {
    signal.throwIfAborted();
    return sourceResult(
      scope,
      "opencode",
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "error",
      [],
      "Local OpenCode usage could not be read",
    );
  }
}
