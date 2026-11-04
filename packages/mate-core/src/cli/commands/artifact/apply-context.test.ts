import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  reconstructPayload,
  type ApplyEnvelope,
  type FullEnvelope,
} from "../../../lib/apply-context/protocol";
import type { OpenSpecRun, OpenSpecRunOptions } from "../../../lib/openspec-cli";
import type { LaunchContext } from "../../../lib/orchestrator/framework-context";
import { generatedHeader } from "../../../runtime/projection";
import { defaultSecretPolicy } from "../../../runtime/secret-patterns";
import {
  runArtifactApplyContextCommand,
  wrappedOpenSpecCwd,
  type ApplyContextCommandDeps,
} from "./apply-context";

const TASKS = 18;

let companion: string;
let repo: string;
let changeDir: string;
let tasksFile: string;
let out: string[];
let err: string[];
let calls: { args: string[]; options: OpenSpecRunOptions }[];

function description(index: number): string {
  return `${Math.floor(index / 6) + 1}.${(index % 6) + 1} Add the acme queue step ${index + 1}: wire the handler, cover it with a focused test, and keep the existing retry and timeout behaviour unchanged`;
}

function tasksMarkdown(done: number): string {
  return [
    "# Tasks: acme-queue",
    "",
    ...Array.from(
      { length: TASKS },
      (_, index) => `- [${index < done ? "x" : " "}] ${description(index)}`,
    ),
    "",
  ].join("\n");
}

/** What `openspec instructions apply --json` would return for the current `tasks.md`. */
async function upstreamPayload(
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const lines = (await fs.readFile(tasksFile, "utf8")).split("\n");
  const tasks = lines.flatMap((line, index) => {
    const match = /^- \[([ x])\] (.*)$/.exec(line);
    return match
      ? [
          {
            id: "",
            description: match[2],
            done: match[1] === "x",
            sourcePath: tasksFile,
            line: index + 1,
          },
        ]
      : [];
  });
  tasks.forEach((task, index) => (task.id = String(index + 1)));
  const complete = tasks.filter((task) => task.done).length;
  return {
    changeName: "acme-queue",
    changeDir,
    schemaName: "mate-v1",
    contextFiles: {
      proposal: [path.join(changeDir, "proposal.md")],
      tasks: [tasksFile],
    },
    progress: { total: tasks.length, complete, remaining: tasks.length - complete },
    tasks,
    taskTrackingConfigured: true,
    state: complete === tasks.length ? "all_done" : "ready",
    instruction: "Read context files and work through pending tasks. Mark complete as you go.",
    root: { path: companion, source: "nearest" },
    ...extra,
  };
}

type Upstream = () => Promise<OpenSpecRun>;
let upstream: Upstream;

const ok = async (extra: Record<string, unknown> = {}): Promise<OpenSpecRun> => ({
  code: 0,
  stdout: JSON.stringify(await upstreamPayload(extra)),
  stderr: "",
});

function deps(overrides: Partial<ApplyContextCommandDeps> = {}): ApplyContextCommandDeps {
  return {
    cwd: () => repo,
    ensureUnambiguousCompanion: async () => true,
    resolveContext: async () =>
      ({
        companionPath: companion,
        repository: { id: "acme", path: repo },
        repositoryId: "acme",
      }) as LaunchContext,
    loadCapabilities: async () => [{ name: "openspec" }],
    loadSecretPolicy: async () => defaultSecretPolicy(),
    producer: () => ({ openspec: "1.15.0" }),
    run: async (args, options) => {
      calls.push({ args, options });
      return upstream();
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  };
}

async function command(args: string[], overrides: Partial<ApplyContextCommandDeps> = {}) {
  out = [];
  err = [];
  await runArtifactApplyContextCommand(args, deps(overrides));
  return out.length ? (JSON.parse(out[0]) as ApplyEnvelope) : undefined;
}

async function check(index: number): Promise<void> {
  const text = await fs.readFile(tasksFile, "utf8");
  await fs.writeFile(
    tasksFile,
    text.replace(`- [ ] ${description(index)}`, `- [x] ${description(index)}`),
  );
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

beforeEach(async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "apply-context-cmd-")));
  companion = path.join(base, "companion");
  repo = path.join(base, "acme");
  changeDir = path.join(companion, "openspec", "changes", "acme-queue");
  tasksFile = path.join(changeDir, "tasks.md");
  await fs.mkdir(changeDir, { recursive: true });
  await fs.mkdir(path.join(repo, "openspec"), { recursive: true });
  await fs.writeFile(
    path.join(repo, "openspec", "config.yaml"),
    `${generatedHeader()}\nstore: acme\n`,
  );
  await fs.writeFile(path.join(changeDir, "proposal.md"), "## Why\n\nAcme needs a queue.\n");
  await fs.writeFile(tasksFile, tasksMarkdown(0));
  upstream = () => ok();
  calls = [];
  process.exitCode = 0;
});

afterEach(async () => {
  await fs.rm(path.dirname(companion), { recursive: true, force: true });
  process.exitCode = 0;
});

describe("mate artifact apply-context", () => {
  test("without --since it returns the full upstream payload and a digest", async () => {
    const envelope = (await command(["acme-queue", "--json"])) as FullEnvelope;
    expect(envelope.mode).toBe("full");
    expect(envelope.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(envelope.payload).toEqual(await upstreamPayload());
    expect(calls[0].args).toEqual(["instructions", "apply", "--change", "acme-queue", "--json"]);
    expect(calls[0].options.cwd).toBe(repo);
    expect(process.exitCode).toBe(0);
  });

  test("replays a full baseline plus 18 compact updates into every fresh upstream payload", async () => {
    const baseline = (await command(["acme-queue", "--json"])) as FullEnvelope;
    let fullSequence = bytes(baseline);
    let compactSequence = bytes(baseline);
    for (let index = 0; index < TASKS; index++) {
      await check(index);
      const fresh = await upstreamPayload();
      const update = await command(["acme-queue", "--json", "--since", baseline.digest as string]);
      expect(update?.mode).toBe("compact");
      expect(reconstructPayload(baseline, update as ApplyEnvelope)).toEqual(fresh);
      const full = await command(["acme-queue", "--json"]);
      expect(bytes(update)).toBeLessThanOrEqual(bytes(full) * 0.5);
      fullSequence += bytes(full);
      compactSequence += bytes(update);
    }
    expect(compactSequence).toBeLessThanOrEqual(fullSequence * 0.5);
    // Every call fetched fresh upstream output: nothing is cached.
    expect(calls.length).toBe(1 + TASKS * 2);
  });

  test("an edited context file invalidates the baseline", async () => {
    const baseline = (await command(["acme-queue", "--json"])) as FullEnvelope;
    await fs.writeFile(path.join(changeDir, "proposal.md"), "## Why\n\nAcme needs two queues.\n");
    const update = await command(["acme-queue", "--json", "--since", baseline.digest as string]);
    expect(update?.mode).toBe("full");
    expect(update?.digest).not.toBe(baseline.digest);
  });

  test("a new warning or blocked prerequisite returns full", async () => {
    const baseline = (await command(["acme-queue", "--json"])) as FullEnvelope;
    for (const extra of [
      { warnings: ["acme-base is not implemented"] },
      { state: "blocked", missingArtifacts: ["design"] },
    ]) {
      upstream = () => ok(extra);
      const update = (await command([
        "acme-queue",
        "--json",
        "--since",
        baseline.digest as string,
      ])) as FullEnvelope;
      expect(update.mode).toBe("full");
      expect(update.payload).toMatchObject(extra);
    }
  });

  test("a changed producer, unknown field, or structural change returns full", async () => {
    const baseline = (await command(["acme-queue", "--json"])) as FullEnvelope;
    const since = ["--since", baseline.digest as string];
    expect(
      (
        await command(["acme-queue", "--json", ...since], {
          producer: () => ({ openspec: "1.16.0" }),
        })
      )?.mode,
    ).toBe("full");
    upstream = () => ok({ futureField: true });
    const unknown = (await command(["acme-queue", "--json", ...since])) as FullEnvelope;
    expect(unknown.mode).toBe("full");
    expect(unknown.payload.futureField).toBe(true);
    upstream = () => ok();
    await fs.appendFile(tasksFile, `- [ ] 4.1 Add the acme follow-up\n`);
    expect((await command(["acme-queue", "--json", ...since]))?.mode).toBe("full");
  });

  test("a malformed --since returns full with a warning", async () => {
    expect((await command(["acme-queue", "--json", "--since", "abc"]))?.mode).toBe("full");
    expect(err.join("\n")).toContain("not a well-formed digest");
  });

  test("duplicate task ids disable compaction and say why", async () => {
    upstream = async () => {
      const payload = await upstreamPayload();
      (payload.tasks as { id: string }[])[1].id = "1";
      return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
    };
    const envelope = (await command(["acme-queue", "--json"])) as FullEnvelope;
    expect(envelope).toMatchObject({
      mode: "full",
      digest: null,
      limitation: "duplicate task id 1",
    });
  });

  test("an unreadable context file disables compaction without failing", async () => {
    await fs.rm(path.join(changeDir, "proposal.md"));
    const envelope = (await command(["acme-queue", "--json"])) as FullEnvelope;
    expect(envelope.digest).toBeNull();
    expect(envelope.limitation).toContain("unreadable");
    expect(process.exitCode).toBe(0);
  });

  test("upstream failures, timeouts, malformed output, and a missing CLI fail visibly", async () => {
    const failures: [OpenSpecRun, string][] = [
      [{ code: 1, stdout: "", stderr: 'Change "acme-queue" not found' }, "exit code 1"],
      [{ code: null, stdout: "", stderr: "" }, "timed out"],
      [{ code: 0, stdout: "not json", stderr: "" }, "malformed JSON"],
      [{ code: 0, stdout: "[1]", stderr: "" }, "malformed JSON"],
      [
        { code: 1, stdout: "", stderr: "bundled OpenSpec CLI is missing.", missing: true },
        "missing",
      ],
    ];
    for (const [result, message] of failures) {
      upstream = async () => result;
      process.exitCode = 0;
      expect(await command(["acme-queue", "--json"])).toBeUndefined();
      expect(err.join("\n")).toContain(message);
      expect(process.exitCode).toBe(1);
    }
  });

  test("requires --json and exactly one change", async () => {
    expect(await command(["acme-queue"])).toBeUndefined();
    expect(err.join("\n")).toContain("requires --json");
    expect(await command(["--json"])).toBeUndefined();
    expect(err.join("\n")).toContain("requires one change name");
    expect(calls).toHaveLength(0);
  });

  test("writes nothing", async () => {
    const before = await fs.readFile(tasksFile, "utf8");
    const listing = async () =>
      (await fs.readdir(path.dirname(companion), { recursive: true })).sort();
    const files = await listing();
    await command(["acme-queue", "--json"]);
    expect(await listing()).toEqual(files);
    expect(await fs.readFile(tasksFile, "utf8")).toBe(before);
  });
});

describe("wrappedOpenSpecCwd", () => {
  test("uses the Working Repository root when it carries Mate's store pointer", async () => {
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    expect(await wrappedOpenSpecCwd(companion, repo, path.join(repo, "src"))).toEqual({
      cwd: repo,
    });
  });

  test("stays on the companion outside the repository or inside the companion", async () => {
    expect(await wrappedOpenSpecCwd(companion, repo, companion)).toEqual({ cwd: companion });
    expect(await wrappedOpenSpecCwd(companion, repo, os.tmpdir())).toEqual({ cwd: companion });
    expect(await wrappedOpenSpecCwd(companion, undefined, repo)).toEqual({ cwd: companion });
  });

  test("stays on the companion for a user-authored OpenSpec config", async () => {
    await fs.writeFile(path.join(repo, "openspec", "config.yaml"), "schema: spec-driven\n");
    expect(await wrappedOpenSpecCwd(companion, repo, repo)).toEqual({ cwd: companion });
  });

  test("names the missing store pointer, as the wrapper does", async () => {
    await fs.rm(path.join(repo, "openspec"), { recursive: true });
    const target = await wrappedOpenSpecCwd(companion, repo, repo);
    expect(target.cwd).toBe(companion);
    expect(target.notice).toContain("no OpenSpec store pointer");
  });
});
