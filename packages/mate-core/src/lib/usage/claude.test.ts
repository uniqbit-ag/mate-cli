import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { claudeObservation, collectClaudeUsage } from "./claude";
import { estimateClaudeCost } from "./claude-pricing";
import { aggregateUsage } from "./aggregate";
import { normalizeUsageRecords } from "./records";
import type { UsageScope } from "./scope";
import { usageWindow } from "./window";

const scope: UsageScope = {
  companionPath: "/acme/companion",
  companionId: "companion",
  fingerprint: "acme",
  capabilities: [],
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
const window = usageWindow(7, new Date("2026-11-07T12:00:00Z"));
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const entry = (id: string) => ({
  type: "assistant",
  cwd: "/acme/web",
  timestamp: "2026-11-07T01:00:00Z",
  sessionId: "acme-session",
  requestId: "acme-request",
  message: {
    id,
    model: "acme-model",
    content: [{ text: "not returned" }],
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    },
  },
});

test("reads attributed main/subagent metadata and omits raw content", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-"));
  await mkdir(path.join(root, "project", "session", "subagents"), { recursive: true });
  await writeFile(
    path.join(root, "project", "session.jsonl"),
    [
      JSON.stringify({ ...entry("acme-main"), costUSD: 0.1 }),
      JSON.stringify({ ...entry("unrelated"), cwd: "/other/web" }),
      "malformed",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "project", "session", "subagents", "acme.jsonl"),
    [JSON.stringify(entry("acme-child")), JSON.stringify(entry("acme-main"))].join("\n"),
  );
  const result = await collectClaudeUsage(scope, window, new AbortController().signal, root);
  const normalized = normalizeUsageRecords(scope, window, result.observations);
  expect(normalized.records).toHaveLength(2);
  expect(normalized.records.find((row) => row.key.startsWith("acme-main"))?.cost?.amount).toBe(0.1);
  expect(normalized.records.find((row) => row.key.startsWith("acme-child"))?.cost).toBeUndefined();
  expect(result.sources[0]!.partial).toBe(true);
  expect(result.sources[0]!.detail).toContain("Some token costs are unknown");
  expect(JSON.stringify(result)).not.toContain("not returned");
});

test("missing local logs are unavailable; readable empty logs are empty", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-"));
  expect(
    (
      await collectClaudeUsage(
        scope,
        window,
        new AbortController().signal,
        path.join(root, "missing"),
      )
    ).sources[0]!.status,
  ).toBe("unavailable");
  expect(
    (await collectClaudeUsage(scope, window, new AbortController().signal, root)).sources[0]!
      .status,
  ).toBe("empty");
});

test("progress records preserve usage metadata and require event/path evidence", () => {
  const progress = claudeObservation({
    type: "progress",
    cwd: "/acme/web",
    data: { type: "agent_progress", message: entry("acme-progress") },
  });
  expect(progress?.tokens?.input).toBe(10);
  expect(claudeObservation({ ...entry("acme"), cwd: undefined })).toBeNull();
  expect(claudeObservation({ ...entry("acme"), message: { usage: {} } })).toBeNull();
});

test("estimates missing costs from model tokens, preserving cache durations and reported zero", () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
  };
  expect(estimateClaudeCost("claude-sonnet-4-6", usage)?.amount).toBeCloseTo(0.007725, 10);
  const base = entry("acme-priced");
  const value = { ...base, message: { ...base.message, model: "claude-sonnet-4-6", usage } };
  expect(claudeObservation(value)?.cost).toEqual({
    amount: 0.007725,
    currency: "USD",
    basis: "estimated",
  });
  expect(claudeObservation({ ...value, costUSD: 0 })?.cost).toEqual({
    amount: 0,
    currency: "USD",
    basis: "reported",
  });
  expect(estimateClaudeCost("acme-unknown", usage)).toBeUndefined();
  expect(estimateClaudeCost("toString", usage)).toBeUndefined();
  expect(
    estimateClaudeCost("claude-sonnet-4-6", { ...usage, cache_read_input_tokens: null }),
  ).toBeUndefined();
  expect(
    estimateClaudeCost("claude-sonnet-4-6", { ...usage, cache_creation: null }),
  ).toBeUndefined();
  expect(estimateClaudeCost("claude-sonnet-4-6", { ...usage, input_tokens: null })).toBeUndefined();
  expect(
    estimateClaudeCost("claude-sonnet-4-6", { ...usage, cache_creation_input_tokens: 301 }),
  ).toBeUndefined();
  expect(
    estimateClaudeCost("claude-sonnet-4-6", {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 300,
    })?.amount,
  ).toBeCloseTo(0.007125, 10);
  expect(
    estimateClaudeCost("claude-sonnet-4-6", { input_tokens: 0, output_tokens: 0 })?.amount,
  ).toBe(0);
});

test("JSONL estimates reconcile across totals, daily, repository and model; reported duplicate wins", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-"));
  const base = entry("acme-priced");
  const value = { ...base, message: { ...base.message, model: "claude-sonnet-4-6" } };
  await writeFile(
    path.join(root, "acme.jsonl"),
    [
      value,
      { ...value, costUSD: 0.1 },
      { ...value, message: { ...value.message, id: "acme-estimated" } },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const result = await collectClaudeUsage(scope, window, new AbortController().signal, root);
  expect(result.sources[0]?.detail).toContain("LiteLLM");
  expect(result.sources[0]?.detail).not.toContain("unknown");
  expect(result.sources[0]?.detail).not.toContain("subscription");
  const snapshot = aggregateUsage(scope, window, [result], "2026-11-07T12:00:00Z");
  const estimate = estimateClaudeCost("claude-sonnet-4-6", value.message.usage)!.amount!;
  expect(snapshot.totals.cost.amount).toBeCloseTo(0.1 + estimate, 10);
  expect(snapshot.totals.cost.basis).toBe("mixed");
  expect(snapshot.repositories[0]!.metrics.cost).toEqual(snapshot.totals.cost);
  expect(snapshot.daily.at(-1)!.metrics.cost).toEqual(snapshot.totals.cost);
  expect(snapshot.breakdowns[0]!.metrics.cost).toEqual(snapshot.totals.cost);
});

test("pricing notes follow actual deduplicated repository costs, not missing stored costs", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-"));
  const otherScope: UsageScope = {
    ...scope,
    repositories: [
      ...scope.repositories,
      {
        ...scope.repositories[0]!,
        id: "api",
        label: "acme/api",
        path: "/acme/api",
        aliases: ["/acme/api"],
      },
    ],
  };
  const unknown = entry("acme-unknown");
  const file = path.join(root, "acme.jsonl");
  await writeFile(
    file,
    [
      unknown,
      { ...unknown, costUSD: 0 },
      {
        ...entry("acme-estimated"),
        message: { ...entry("acme-estimated").message, model: "claude-sonnet-4-6" },
      },
      { ...entry("acme-api"), cwd: "/acme/api" },
      { ...entry("acme-unrelated"), cwd: "/acme/other" },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const result = await collectClaudeUsage(otherScope, window, new AbortController().signal, root);
  expect(result.sources.find((source) => source.repositoryId === "web")!.detail).not.toContain(
    "unknown",
  );
  expect(result.sources.find((source) => source.repositoryId === "api")!.detail).toContain(
    "Some token costs are unknown",
  );
  expect(JSON.stringify(result.sources)).not.toContain("subscription");
  await writeFile(file, "");
  const empty = await collectClaudeUsage(otherScope, window, new AbortController().signal, root);
  expect(empty.sources[0]!.detail).not.toContain("unknown");
});

test("uses record timestamps even when restored transcript modification times precede the window", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-"));
  const stale = path.join(root, "stale.jsonl");
  await writeFile(stale, JSON.stringify(entry("acme-stale")));
  await writeFile(path.join(root, "fresh.jsonl"), JSON.stringify(entry("acme-fresh")));
  await writeFile(
    path.join(root, "outside.jsonl"),
    JSON.stringify({ ...entry("acme-outside"), timestamp: "2026-10-01T01:00:00Z" }),
  );
  const before = new Date(Date.parse(window.start) - 1000);
  await utimes(stale, before, before);
  const result = await collectClaudeUsage(scope, window, new AbortController().signal, root);
  expect(result.observations.map((observation) => observation.key).toSorted()).toEqual([
    "acme-fresh:acme-request",
    "acme-stale:acme-request",
  ]);
  expect(result.sources[0]!.partial).toBeUndefined();
});

test("an unreadable project folder marks Claude partial without discarding other records", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-"));
  const locked = path.join(root, "locked");
  await mkdir(locked);
  await writeFile(path.join(root, "acme.jsonl"), JSON.stringify(entry("acme-kept")));
  await chmod(locked, 0o000);
  try {
    const result = await collectClaudeUsage(scope, window, new AbortController().signal, root);
    expect(result.observations).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ status: "ok", partial: true });
  } finally {
    await chmod(locked, 0o700);
  }
});

test("a timed-out scan reports timeout instead of throwing", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acme-usage-"));
  await writeFile(path.join(root, "acme.jsonl"), JSON.stringify(entry("acme-late")));
  const controller = new AbortController();
  controller.abort();
  const result = await collectClaudeUsage(scope, window, controller.signal, root);
  expect(result.sources[0]).toMatchObject({ status: "timeout", partial: true });
});
