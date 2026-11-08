import { createReadStream } from "node:fs";
import { opendir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CLAUDE_PRICING_DETAIL, estimateClaudeCost } from "./claude-pricing";
import { nonnegative, normalizeUsageRecords, type UsageObservation } from "./records";
import { repositoryForPath, type UsageScope } from "./scope";
import { sourceResult, type UsageCollection } from "./source";
import type { UsageWindow } from "./types";
import { inUsageWindow } from "./window";

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

/** Provider schema: assistant.message.usage, cwd, timestamp, message.id and requestId. */
export function claudeObservation(
  value: Json,
  fallbackDirectory?: string,
): UsageObservation | null {
  const data = object(value.data);
  const entry =
    value.type === "progress" && data?.type === "agent_progress"
      ? { ...object(data.message), cwd: value.cwd, sessionId: value.sessionId }
      : value;
  const message = object(entry.message);
  const usage = object(message?.usage);
  if (!message || !usage || typeof entry.timestamp !== "string") return null;
  const directory = typeof entry.cwd === "string" ? entry.cwd : fallbackDirectory;
  if (!directory || typeof message.id !== "string" || !message.id) return null;
  const reported = nonnegative(entry.costUSD);
  const model = typeof message.model === "string" ? message.model : "unknown";
  const cost =
    reported === null
      ? estimateClaudeCost(model, usage)
      : { amount: reported, currency: "USD", basis: "reported" as const };
  return {
    key: `${message.id}:${typeof entry.requestId === "string" ? entry.requestId : ""}`,
    source: "claude",
    directory,
    timestamp: entry.timestamp,
    model,
    tokens: {
      input: nonnegative(usage.input_tokens),
      output: nonnegative(usage.output_tokens),
      cacheRead: nonnegative(usage.cache_read_input_tokens ?? 0),
      cacheWrite: nonnegative(
        usage.cache_creation_input_tokens ??
          (nonnegative(object(usage.cache_creation)?.ephemeral_5m_input_tokens) ?? 0) +
            (nonnegative(object(usage.cache_creation)?.ephemeral_1h_input_tokens) ?? 0),
      ),
    },
    ...(cost ? { cost } : {}),
  };
}

const RECORD_LIMIT = 100_000;

/** Only the root's failure is fatal; an unreadable or vanished subfolder calls `skipped`. */
async function* usageFiles(
  root: string,
  signal: AbortSignal,
  skipped: () => void,
  depth = 0,
): AsyncGenerator<string> {
  if (depth > 5) return;
  try {
    for await (const entry of await opendir(root)) {
      signal.throwIfAborted();
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) yield* usageFiles(file, signal, skipped, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield file;
    }
  } catch (error) {
    if (depth === 0 || signal.aborted) throw error;
    skipped();
  }
}

async function* jsonLines(file: string, signal: AbortSignal): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: "utf8", signal, highWaterMark: 64 * 1024 });
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        if (end > 2 * 1024 * 1024) throw new Error("Usage line exceeds limit");
        yield pending.slice(0, end);
        pending = pending.slice(end + 1);
      }
      if (pending.length > 2 * 1024 * 1024) throw new Error("Usage line exceeds limit");
    }
    if (pending) yield pending;
  } finally {
    stream.destroy();
  }
}

export async function collectClaudeUsage(
  scope: UsageScope,
  window: UsageWindow,
  signal: AbortSignal,
  projects = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "projects",
  ),
): Promise<UsageCollection> {
  const observations: UsageObservation[] = [];
  let partial = false;
  let count = 0;
  try {
    for await (const file of usageFiles(projects, signal, () => (partial = true))) {
      if (observations.length >= RECORD_LIMIT) break;
      let directory: string | undefined;
      try {
        if (++count > RECORD_LIMIT) {
          partial = true;
          break;
        }
        for await (const line of jsonLines(file, signal)) {
          let entry: Json | null = null;
          try {
            entry = object(JSON.parse(line));
          } catch {
            // Malformed line: counted as partial below.
          }
          if (!entry) {
            partial = true;
            continue;
          }
          if (typeof entry.cwd === "string") directory = entry.cwd;
          const observation = claudeObservation(entry, directory);
          if (!observation) {
            if (object(entry.message)?.usage) partial = true;
            continue;
          }
          if (!inUsageWindow(observation.timestamp, window)) continue;
          if (!repositoryForPath(scope, observation.directory)) continue;
          observations.push(observation);
          if (observations.length >= RECORD_LIMIT) {
            partial = true;
            break;
          }
        }
      } catch {
        if (signal.aborted) break;
        partial = true;
      }
    }
  } catch (error) {
    // A timeout keeps the records read so far; see the result status below.
    if (!signal.aborted)
      return sourceResult(
        scope,
        "claude",
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "error",
        [],
        "Local Claude usage logs are unavailable",
      );
  }
  const timedOut = signal.aborted;
  const result = sourceResult(
    scope,
    "claude",
    timedOut ? "timeout" : observations.length ? "ok" : "empty",
    observations,
    [
      timedOut ? "Collection timed out; records read before the deadline are included." : "",
      partial ? "Some usage records could not be read or attributed." : "",
      CLAUDE_PRICING_DETAIL,
    ]
      .filter(Boolean)
      .join(" "),
    partial || timedOut,
  );
  const unpriced = new Set(
    normalizeUsageRecords(scope, window, observations)
      .records.filter((record) => record.cost?.amount == null)
      .map((record) => record.repositoryId),
  );
  for (const source of result.sources) {
    if (unpriced.has(source.repositoryId))
      source.detail +=
        " Some token costs are unknown: model rates or token counts are unavailable.";
  }
  return result;
}
