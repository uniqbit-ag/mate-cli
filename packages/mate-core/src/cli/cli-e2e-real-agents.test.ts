/** @test-requires sockets, agent binaries */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { accessSync, constants } from "node:fs";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parse } from "yaml";

import { readCompanionGitRecord } from "../runtime/companion-git-state";
import { projectionEnvPath, projectionYamlPath } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { makeSshStub, stubSshUrl } from "../../../../test/ssh-stub";

// Local-only, opt-in verification that mate's companion-guidance injection ends
// up EXACTLY ONCE in the system prompt that the REAL `claude` and `opencode`
// binaries send to the model API. Unlike cli-e2e.test.ts's launch tests (which
// substitute capturing stub binaries), these tests spawn the actual CLIs and
// redirect their outbound model requests to a local mock HTTP server, so no
// real network request or agentic tool call ever happens.
//
// This file is intentionally self-contained (it duplicates the small subset of
// cli-e2e.test.ts's scenario plumbing it needs) rather than importing from it,
// so the stub-based hermetic suite and this real-binary suite stay decoupled.
//
// Gating: skipped unless explicitly enabled, and skipped per-tool when the
// real `claude`/`opencode` binary isn't resolvable on PATH locally.

const APP_ROOT = path.resolve(import.meta.dirname, "../../../../apps/mate-cli");
const E2E_TMP_ROOT = path.join(os.tmpdir(), "mate-cli-e2e");
const tempRoots: string[] = [];

// Real CLI startup + a real (if local) HTTP round trip is slower than the
// stub-based suite; give this file a generous default and per-run watchdog.
const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const RUN_MATE_WATCHDOG_MS = 45_000;
setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);

const DUMMY_API_KEY = "sk-ant-dummy-test-key";
// `-m provider/model` CLI selector vs. the bare id the API request body actually carries.
const OPENCODE_MODEL = "anthropic/claude-sonnet-4-5";
const OPENCODE_MODEL_ID = "claude-sonnet-4-5";
const COMPANION_GUIDANCE_MARKERS = [
  "\n<companion-policy ",
  "\n<codebase-exploration-rules",
] as const;
const CONTEXT_MODE_GUIDANCE_MARKER = "\n## Context Mode\n";
/**
 * Native memory strips HTML comments, so Claude's companion rules are found by
 * text: a rule sentence from the template's `MATE:COMPANION` block, and a
 * sentinel the user wrote into the companion `AGENTS.md`.
 */
const COMPANION_RULE_SENTENCE = "Code comments: sparse and concise";
const USER_SENTINEL = "ACME-COMPANION-SENTINEL-5d1e";
const INSTRUCTIONS_MARKER = "<companion-instructions";

function isBinaryOnPath(command: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  return pathEnv.split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(path.join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const runRealAgentTests = process.env.MATE_RUN_REAL_AGENT_TESTS === "1";
const hasClaude = isBinaryOnPath("claude");
const hasOpenCode = isBinaryOnPath("opencode");

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface E2EScenario {
  root: string;
  home: string;
  companion: string;
  working: string;
  bin: string;
}

async function makeTempDir(prefix: string): Promise<string> {
  await fs.mkdir(E2E_TMP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(E2E_TMP_ROOT, prefix));
  tempRoots.push(dir);
  return dir;
}

async function seedUpdateState(home: string): Promise<void> {
  const updateDir = path.join(home, ".mate");
  await fs.mkdir(updateDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(updateDir, "update-state-uniqbit-mate.yaml"),
      ["lastChecked: 2099-01-01T00:00:00.000Z", "latestVersion: null", ""].join("\n"),
      "utf8",
    ),
    fs.writeFile(
      path.join(updateDir, "update-state-uniqbit-mate-canary.yaml"),
      ["lastChecked: 2099-01-01T00:00:00.000Z", "latestVersion: null", ""].join("\n"),
      "utf8",
    ),
  ]);
}

async function createScenario(prefix: string): Promise<E2EScenario> {
  const rawRoot = await makeTempDir(prefix);
  const rawHome = path.join(rawRoot, "home");
  const rawCompanion = path.join(rawHome, ".mate", "companions", "app");
  const rawWorking = path.join(rawRoot, "app");
  const rawBin = path.join(rawRoot, "bin");

  await Promise.all([
    fs.mkdir(rawHome, { recursive: true }),
    fs.mkdir(rawCompanion, { recursive: true }),
    fs.mkdir(rawWorking, { recursive: true }),
    fs.mkdir(rawBin, { recursive: true }),
  ]);

  const [root, home, companion, working, bin] = await Promise.all([
    fs.realpath(rawRoot),
    fs.realpath(rawHome),
    fs.realpath(rawCompanion),
    fs.realpath(rawWorking),
    fs.realpath(rawBin),
  ]);

  await seedUpdateState(home);

  return { root, home, companion, working, bin };
}

async function runMate(
  scenario: E2EScenario,
  {
    cwd,
    args,
    input,
    env,
  }: {
    cwd: string;
    args: string[];
    input?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    // Real binaries picked up from the real PATH (appended after scenario.bin,
    // where only the lightweight companion-tooling stubs below live) — this is
    // what lets `claude`/`opencode` resolve to the actual system install.
    const child = spawn("bun", [path.join(APP_ROOT, "src/cli.ts"), ...args], {
      cwd,
      env: withoutParentClaudeSession({
        ...process.env,
        HOME: scenario.home,
        PWD: cwd,
        PATH: `${scenario.bin}:${process.env.PATH ?? ""}`,
        TERM_PROGRAM: "",
        VSCODE_IPC_HOOK: "",
        __CFBundleIdentifier: "",
        CI: "", // unset so piped stdin ("y\n") is read normally in the spawned process
        MATE_ARTIFACT_PATH: "",
        MATE_VERSION: "",
        MATE_REPO_ID: "",
        MATE_REPO_PATH: "",
        MATE_POLICY_JSON: "",
        MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH: "1",
        ...env,
      }),
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `runMate timed out after ${RUN_MATE_WATCHDOG_MS}ms: bun ${path.join(APP_ROOT, "src/cli.ts")} ${args.join(" ")}\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    }, RUN_MATE_WATCHDOG_MS);
    watchdog.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

async function runMateInTty(
  scenario: E2EScenario,
  {
    cwd,
    args,
    inputChunks,
    env,
    timeoutSeconds,
  }: {
    cwd: string;
    args: string[];
    inputChunks: Array<string | { chunk: string; delayMs?: number }>;
    env?: NodeJS.ProcessEnv;
    timeoutSeconds?: number;
  },
): Promise<CliRunResult> {
  const toTclString = (value: string) =>
    `"${value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("$", "\\$")
      .replaceAll("[", "\\[")
      .replaceAll("]", "\\]")
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")}"`;
  /**
   * Run through `sh` so mate's exit code reaches us as an output marker: the
   * `wait` builtin blocks on this expect build once the child is reaped.
   */
  const command = [
    "sh",
    "-c",
    `bun "$@"; printf '\\n${TTY_EXIT_MARKER}%s\\n' "$?"`,
    "mate-e2e",
    path.join(APP_ROOT, "src/cli.ts"),
    ...args,
  ]
    .map(toTclString)
    .join(" ");
  const sends = inputChunks
    .map((entry) => {
      const step = typeof entry === "string" ? { chunk: entry } : entry;
      return [`after ${step.delayMs ?? 150}`, `send -- ${toTclString(step.chunk)}`].join("\n");
    })
    .join("\n");
  /**
   * Ink frames do not reach expect before exit, so the first key waits for the
   * prompt to switch the PTY to raw mode instead: keys typed earlier land in
   * the cooked line buffer and arrive as one chunk the prompt discards.
   */
  const expectScript = [
    `set timeout ${timeoutSeconds ?? 8}`,
    "log_user 1",
    `spawn -noecho ${command}`,
    ...(inputChunks.length > 0 ? WAIT_FOR_RAW_MODE_TCL : []),
    sends,
    "expect {",
    "  eof {}",
    "  timeout { exit 124 }",
    "}",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn("expect", ["-c", expectScript], {
      cwd,
      env: {
        ...process.env,
        HOME: scenario.home,
        PWD: cwd,
        PATH: `${scenario.bin}:${process.env.PATH ?? ""}`,
        TERM_PROGRAM: "",
        VSCODE_IPC_HOOK: "",
        __CFBundleIdentifier: "",
        CI: "",
        MATE_ARTIFACT_PATH: "",
        MATE_VERSION: "",
        MATE_REPO_ID: "",
        MATE_REPO_PATH: "",
        MATE_POLICY_JSON: "",
        MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH: "1",
        ...env,
      },
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(withTtyExitCode(exitCode, stdout, stderr)));
    child.stdin.end();
  });
}

const TTY_EXIT_MARKER = "__MATE_E2E_EXIT__";

/** Polls the PTY until the prompt has taken it into raw mode, failing like a timeout. */
const WAIT_FOR_RAW_MODE_TCL = [
  "set tty $spawn_out(slave,name)",
  "set deadline [expr {[clock milliseconds] + $timeout * 1000}]",
  "while {[catch {exec stty -a < $tty} modes] || ![regexp -- {-icanon} $modes]} {",
  "  if {[clock milliseconds] > $deadline} { exit 124 }",
  "  after 25",
  "}",
];

/** Mate's own exit code from the marker; expect's (124 on timeout) when mate never finished. */
function withTtyExitCode(
  expectExitCode: number | null,
  stdout: string,
  stderr: string,
): CliRunResult {
  const marker = new RegExp(`\\r?\\n${TTY_EXIT_MARKER}(\\d+)\\r?\\n?`);
  const match = stdout.match(marker);
  if (!match) return { exitCode: expectExitCode || 1, stdout, stderr };
  return { exitCode: Number(match[1]), stdout: stdout.replace(marker, ""), stderr };
}

async function writeUvStub(scenario: E2EScenario): Promise<void> {
  const stubPath = path.join(scenario.bin, "uv");
  const source = [
    "#!/usr/bin/env bun",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'init') {",
    "  const fs = require('node:fs');",
    "  fs.writeFileSync('pyproject.toml', '[project]\\nname = \"companion\"\\nversion = \"0.1.0\"\\n');",
    "  fs.writeFileSync('uv.lock', '');",
    "}",
    "process.exit(0);",
    "",
  ].join("\n");
  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
}

async function writeRtkStub(scenario: E2EScenario): Promise<void> {
  const stubPath = path.join(scenario.bin, "rtk");
  await fs.writeFile(stubPath, "#!/usr/bin/env bun\nprocess.exit(0);\n", "utf8");
  await fs.chmod(stubPath, 0o755);
}

async function writeOpenSpecStub(scenario: E2EScenario): Promise<void> {
  const stubPath = path.join(scenario.bin, "openspec");
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const args = process.argv.slice(2);",
    "const skills = ['openspec-explore', 'openspec-propose', 'openspec-apply-change', 'openspec-archive-change'];",
    "const runtimeDirs = { claude: '.claude', opencode: '.opencode' };",
    "const command = args[0];",
    "const targetPath = args[args.length - 1];",
    "if (command === 'init') {",
    "  const toolsArg = args[args.indexOf('--tools') + 1] ?? '';",
    "  for (const tool of toolsArg.split(',').filter(Boolean)) {",
    "    const runtimeDir = runtimeDirs[tool];",
    "    if (!runtimeDir) continue;",
    "    for (const skill of skills) {",
    "      const skillDir = path.join(targetPath, runtimeDir, 'skills', skill);",
    "      fs.mkdirSync(skillDir, { recursive: true });",
    "      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${tool}:${skill}\\n`);",
    "    }",
    "  }",
    "  process.exit(0);",
    "}",
    "if (command === 'update' || command === 'templates') process.exit(0);",
    "process.exit(1);",
    "",
  ].join("\n");
  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
}

async function writeGraphifyStub(scenario: E2EScenario): Promise<void> {
  const stubPath = path.join(scenario.bin, "graphify");
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const args = process.argv.slice(2);",
    "if (args[0] === 'install' && args.includes('--project')) {",
    "  const platIdx = args.indexOf('--platform');",
    "  const platform = platIdx >= 0 ? args[platIdx + 1] : 'unknown';",
    "  const cwd = process.cwd();",
    "  const provDir = `.${platform}`;",
    "  fs.mkdirSync(path.join(cwd, provDir, 'skills', 'graphify'), { recursive: true });",
    "  fs.writeFileSync(path.join(cwd, provDir, 'skills', 'graphify', 'SKILL.md'), '# graphify\\n', 'utf8');",
    "}",
    "process.exit(0);",
    "",
  ].join("\n");
  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
}

// Enables both `openspec` and `graphify` capabilities: buildCompanionGuidance
// only appends the `<codebase-exploration-rules>` block when at least one of
// graphify/tokensave is active, so a graphify stub is required for that
// marker to actually show up in the real system prompt.
async function setupCompanion(
  scenario: E2EScenario,
  allowedAgents: string[],
  extraArgs: string[] = [],
): Promise<CliRunResult> {
  await writeUvStub(scenario);
  await writeRtkStub(scenario);
  await writeOpenSpecStub(scenario);
  await writeGraphifyStub(scenario);

  return runMate(scenario, {
    cwd: scenario.companion,
    args: [
      "companion",
      "setup",
      ...allowedAgents.flatMap((agent) => ["--allowed-agent", agent]),
      "--capability",
      "openspec",
      "--capability",
      "graphify",
      "--capability",
      "context-mode",
      ...extraArgs,
    ],
    input: "y\n",
  });
}

async function linkRepository(scenario: E2EScenario): Promise<CliRunResult> {
  const linkResult = await runMateInTty(scenario, {
    cwd: scenario.working,
    args: ["companion", "link"],
    inputChunks: [
      { chunk: "\x1b[B", delayMs: 1000 },
      { chunk: "\r", delayMs: 1000 },
      { chunk: "\r", delayMs: 1000 },
    ],
  });
  if (linkResult.exitCode !== 0) return linkResult;

  const installResult = await runMate(scenario, {
    cwd: scenario.companion,
    args: ["install", "--yes"],
  });
  return {
    exitCode: installResult.exitCode,
    stdout: `${linkResult.stdout}${installResult.stdout}`,
    stderr: `${linkResult.stderr}${installResult.stderr}`,
  };
}

function initWorkingRepoGit(scenario: E2EScenario): void {
  spawnSync("git", ["init", "-q"], { cwd: scenario.working, stdio: "ignore" });
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** The companion as committed, pushed to a bare origin, and a second clone to push from. */
function gitBackedCompanion(scenario: E2EScenario): { remote: string; upstream: string } {
  const remote = path.join(scenario.root, "companion-origin.git");
  const upstream = path.join(scenario.root, "companion-upstream");
  runGit(scenario.root, ["init", "--bare", "-q", "--initial-branch=main", remote]);
  runGit(scenario.companion, ["init", "-q", "--initial-branch=main"]);
  for (const cwd of [scenario.companion]) {
    runGit(cwd, ["config", "user.email", "mate-e2e@example.com"]);
    runGit(cwd, ["config", "user.name", "Mate E2E"]);
  }
  runGit(scenario.companion, ["add", "."]);
  runGit(scenario.companion, ["commit", "-qm", "initial companion state"]);
  runGit(scenario.companion, ["remote", "add", "origin", remote]);
  runGit(scenario.companion, ["push", "-q", "-u", "origin", "main"]);
  runGit(scenario.root, ["clone", "-q", remote, upstream]);
  runGit(upstream, ["config", "user.email", "mate-e2e@example.com"]);
  runGit(upstream, ["config", "user.name", "Mate E2E"]);
  return { remote, upstream };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Mock model server. */

interface CapturedRequest {
  url: string;
  body: string;
  model: string | null;
}

interface MockModelServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

type MockReply = { text: string } | { toolUse: { name: string; input: unknown } };
type MockResponder = (request: CapturedRequest) => MockReply;
const replyHi: MockResponder = () => ({ text: "hi" });

function flattenSystemPrompt(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  const system = (parsed as { system?: unknown })?.system;
  return flattenContent(system);
}

// Claude's `system` field is an array of content blocks; OpenCode's is a
// single `{ type: "text", text: ... }` object rather than a one-element
// array — accept both shapes (and a plain string) uniformly.
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "string" ? block : ((block as { text?: string })?.text ?? ""),
      )
      .join("\n");
  }
  if (content && typeof content === "object") {
    return (content as { text?: string }).text ?? "";
  }
  return "";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function streamReply(res: ServerResponse, id: string, reply: MockReply): void {
  const block =
    "text" in reply
      ? {
          start: { type: "text", text: "" },
          delta: { type: "text_delta", text: reply.text },
          stopReason: "end_turn",
        }
      : {
          start: { type: "tool_use", id: `toolu_${id}`, name: reply.toolUse.name, input: {} },
          delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.toolUse.input) },
          stopReason: "tool_use",
        };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "mock-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: block.start,
  });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: block.delta });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: block.stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

// Starts a minimal HTTP server that stands in for the real Anthropic Messages
// API. Claude Code posts to a path containing `/v1/messages`; OpenCode posts
// to a path containing `/messages` (no `/v1` prefix) — match on either shape.
// Both `claude --print` and `opencode run` request streaming by default, so a
// minimal SSE response is required for a real turn to complete; a
// non-streaming JSON reply is served as a fallback for completeness.
async function startMockModelServer(respond: MockResponder = replyHi): Promise<MockModelServer> {
  const requests: CapturedRequest[] = [];

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");

      if (!req.url?.includes("/messages")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }

      let streaming = false;
      let model: string | null = null;
      try {
        const parsed = JSON.parse(raw) as { stream?: boolean; model?: string };
        streaming = parsed.stream === true;
        model = typeof parsed.model === "string" ? parsed.model : null;
      } catch {
        // non-JSON body; fall through to the non-streaming reply below
      }

      const captured = { url: req.url ?? "", body: raw, model };
      requests.push(captured);
      const reply = respond(captured);

      if (streaming) {
        streamReply(res, `msg_mock_${requests.length}`, reply);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_mock",
            type: "message",
            role: "assistant",
            model: "mock-model",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Includes the messages, tool results too: hook context arrives there, not in the system prompt. */
function flattenRequest(body: string): string {
  let parsed: { messages?: Array<{ content?: unknown }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  const messageText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block: { text?: unknown; content?: unknown }) =>
        typeof block?.text === "string" ? block.text : messageText(block?.content),
      )
      .join("\n");
  };
  return [
    flattenSystemPrompt(body),
    ...(parsed.messages ?? []).map((message) => messageText(message.content)),
  ].join("\n");
}

function expectExactlyOnce(haystack: string, needle: string, label: string): void {
  const count = countOccurrences(haystack, needle);
  if (count !== 1) throw new Error(`${label} (${JSON.stringify(needle)}) appeared ${count} times`);
}

function assertCompanionRulesOnce(body: string, context: string): void {
  const request = flattenRequest(body);
  expectExactlyOnce(request, COMPANION_RULE_SENTENCE, `${context}: MATE:COMPANION rule sentence`);
  expectExactlyOnce(request, USER_SENTINEL, `${context}: user sentinel`);
}

/** A user-written section the template does not hold, so only real delivery can carry it. */
async function addUserSentinel(scenario: E2EScenario): Promise<void> {
  await fs.appendFile(
    path.join(scenario.companion, "AGENTS.md"),
    `\n## Acme notes\n\n- ${USER_SENTINEL}\n`,
    "utf8",
  );
}

/**
 * The conversation request that carries `prompt`. Only conversation turns
 * offer tools; Claude Code's session-title request quotes the prompt too.
 */
function requestFor(mock: MockModelServer, prompt: string): CapturedRequest {
  const found = mock.requests.find(
    (request) =>
      toolNames(request.body).length > 0 && flattenRequest(request.body).includes(prompt),
  );
  if (!found) {
    throw new Error(
      `no captured request carries ${JSON.stringify(prompt)} (${mock.requests.length} captured)`,
    );
  }
  return found;
}

function assertMarkersAppearExactlyOnce(body: string): void {
  const system = flattenSystemPrompt(body);
  for (const marker of COMPANION_GUIDANCE_MARKERS) {
    expectExactlyOnce(system, marker, "system prompt guidance marker");
  }
}

/**
 * The scenario's own environment for a real `claude`: no `CLAUDE_CODE_*` or
 * `CLAUDECODE` from a Claude session running this suite, which would otherwise
 * change what the child loads.
 */
function withoutParentClaudeSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    if (name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_")) delete clean[name];
  }
  return clean;
}

async function runPlainClaude(
  scenario: E2EScenario,
  cwd: string,
  args: string[],
  mock: MockModelServer,
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      env: withoutParentClaudeSession({
        ...plainEnv(scenario),
        PWD: cwd,
        ANTHROPIC_API_KEY: DUMMY_API_KEY,
        ANTHROPIC_BASE_URL: mock.baseUrl,
      }),
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    const watchdog = setTimeout(() => child.kill("SIGKILL"), RUN_MATE_WATCHDOG_MS);
    watchdog.unref?.();
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(watchdog);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
    child.stdin.end();
  });
}

const RESUME_SENTINEL = "ACME-RESUME-SENTINEL-9b2c";
const DELEGATE_PROMPT = "ACME-DELEGATE: start one general-purpose subagent";
const SUBAGENT_TASK = "ACME-SUBAGENT-TASK: reply with ok";

function toolNames(body: string): string[] {
  try {
    const tools = (JSON.parse(body) as { tools?: Array<{ name?: string }> }).tools ?? [];
    return tools.map((tool) => tool.name ?? "");
  } catch {
    return [];
  }
}

function isSubagentRequest(request: CapturedRequest): boolean {
  const text = flattenRequest(request.body);
  return text.includes(SUBAGENT_TASK) && !text.includes(DELEGATE_PROMPT);
}

const delegateOnce: MockResponder = (request) => {
  const text = flattenRequest(request.body);
  const agentTool = toolNames(request.body).find((name) => name === "Agent" || name === "Task");
  if (agentTool && text.includes(DELEGATE_PROMPT) && !request.body.includes('"tool_result"')) {
    return {
      toolUse: {
        name: agentTool,
        input: {
          description: "acme check",
          prompt: SUBAGENT_TASK,
          subagent_type: "general-purpose",
        },
      },
    };
  }
  return { text: "ok" };
};

async function claudeScenario(prefix: string): Promise<E2EScenario> {
  const scenario = await createScenario(prefix);
  initWorkingRepoGit(scenario);
  expect((await setupCompanion(scenario, ["claude"])).exitCode).toBe(0);
  expect((await linkRepository(scenario)).exitCode).toBe(0);
  await addUserSentinel(scenario);
  return scenario;
}

function mateClaudeEnv(mock: MockModelServer): NodeJS.ProcessEnv {
  return { ANTHROPIC_API_KEY: DUMMY_API_KEY, ANTHROPIC_BASE_URL: mock.baseUrl };
}

/** A linked worktree of the working repository, with no `.claude/` and no manifest of its own. */
async function linkedWorktree(scenario: E2EScenario): Promise<string> {
  runGit(scenario.working, [
    "-c",
    "user.email=mate-e2e@example.com",
    "-c",
    "user.name=Mate E2E",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  const worktree = path.join(scenario.root, "app-worktree");
  runGit(scenario.working, ["worktree", "add", "-q", worktree]);
  /** Its `.mate/` names the companion, as in the incident's worktree: registry and projection only. */
  for (const file of [repoLocalRegistryPath, projectionYamlPath, projectionEnvPath]) {
    await fs.mkdir(path.dirname(file(worktree)), { recursive: true });
    await fs.copyFile(file(scenario.working), file(worktree));
  }
  await expect(fs.access(path.join(worktree, ".claude"))).rejects.toThrow();
  await expect(fs.access(path.join(worktree, ".mate", "runtime-documents.json"))).rejects.toThrow();
  return worktree;
}

describe.skipIf(!runRealAgentTests || !hasClaude)(
  "real claude agent — system prompt injection",
  () => {
    test("companion guidance markers each appear exactly once in the real system prompt", async () => {
      const scenario = await claudeScenario("mate-cli-e2e-real-claude-");
      const mock = await startMockModelServer();

      try {
        const result = await runMate(scenario, {
          cwd: scenario.working,
          args: ["claude", "--print", "say hi"],
          input: "y\n",
          env: mateClaudeEnv(mock),
        });

        expect(result.exitCode).toBe(0);
        /** The conversation request, not Claude Code's session-title request. */
        const body = requestFor(mock, "say hi").body;
        assertMarkersAppearExactlyOnce(body);
        expect(countOccurrences(flattenSystemPrompt(body), CONTEXT_MODE_GUIDANCE_MARKER)).toBe(0);
        /** The wrap's session hook carries them, as in a plain session; the appended prompt holds none. */
        expect(countOccurrences(flattenSystemPrompt(body), INSTRUCTIONS_MARKER)).toBe(0);
        expectExactlyOnce(flattenRequest(body), INSTRUCTIONS_MARKER, "mate claude: request");
        assertCompanionRulesOnce(body, "mate claude");
      } finally {
        await mock.close();
      }
    });

    test("a companion-scoped launch gets the rules once, from native memory", async () => {
      const scenario = await claudeScenario("mate-cli-e2e-real-claude-companion-");
      const mock = await startMockModelServer();

      try {
        const result = await runMate(scenario, {
          cwd: scenario.companion,
          args: ["claude", "--print", "say hi", "--", "--companion"],
          input: "y\n",
          env: mateClaudeEnv(mock),
        });

        expect(result.exitCode).toBe(0);
        const body = requestFor(mock, "say hi").body;
        assertCompanionRulesOnce(body, "companion-scoped launch");
        expect(countOccurrences(flattenRequest(body), INSTRUCTIONS_MARKER)).toBe(0);
      } finally {
        await mock.close();
      }
    });

    test("a general-purpose subagent of mate claude gets the rules once", async () => {
      const scenario = await claudeScenario("mate-cli-e2e-real-claude-subagent-");
      const mock = await startMockModelServer(delegateOnce);

      try {
        const result = await runMate(scenario, {
          cwd: scenario.working,
          args: ["claude", "--print", DELEGATE_PROMPT],
          input: "y\n",
          env: mateClaudeEnv(mock),
        });

        expect(result.exitCode).toBe(0);
        const subagent = mock.requests.find(isSubagentRequest);
        if (!subagent) throw new Error(`no subagent request among ${mock.requests.length}`);
        expectExactlyOnce(flattenRequest(subagent.body), INSTRUCTIONS_MARKER, "managed subagent");
        assertCompanionRulesOnce(subagent.body, "managed subagent");
      } finally {
        await mock.close();
      }
    }, 120_000);
  },
);

describe.skipIf(!runRealAgentTests || !hasClaude)(
  "real claude — plain session in a Claude-wrapped repository",
  () => {
    test("a plain claude --print gets the rules once, and so does its subagent", async () => {
      const scenario = await claudeScenario("mate-cli-e2e-plain-claude-");
      expect((await runMate(scenario, { cwd: scenario.working, args: ["wrap"] })).exitCode).toBe(0);
      const mock = await startMockModelServer(delegateOnce);

      try {
        const result = await runPlainClaude(
          scenario,
          scenario.working,
          ["--print", DELEGATE_PROMPT],
          mock,
        );

        expect(result.exitCode).toBe(0);
        const main = requestFor(mock, DELEGATE_PROMPT).body;
        expectExactlyOnce(flattenRequest(main), INSTRUCTIONS_MARKER, "plain session");
        assertCompanionRulesOnce(main, "plain session");
        const subagent = mock.requests.find(isSubagentRequest);
        if (!subagent) throw new Error(`no subagent request among ${mock.requests.length}`);
        expectExactlyOnce(flattenRequest(subagent.body), INSTRUCTIONS_MARKER, "plain subagent");
        assertCompanionRulesOnce(subagent.body, "plain subagent");
      } finally {
        await mock.close();
      }
    }, 120_000);

    test("a plain session in a linked worktree gets the rules once from the main checkout's wrap", async () => {
      const scenario = await claudeScenario("mate-cli-e2e-plain-claude-worktree-");
      expect((await runMate(scenario, { cwd: scenario.working, args: ["wrap"] })).exitCode).toBe(0);
      const worktree = await linkedWorktree(scenario);
      const mock = await startMockModelServer();

      try {
        const result = await runPlainClaude(scenario, worktree, ["--print", "say hi"], mock);

        expect(result.exitCode).toBe(0);
        const body = requestFor(mock, "say hi").body;
        expectExactlyOnce(flattenRequest(body), INSTRUCTIONS_MARKER, "worktree session");
        assertCompanionRulesOnce(body, "worktree session");
      } finally {
        await mock.close();
      }
    }, 120_000);

    test("a plain session in a new sibling worktree has an artifact write blocked, and adopts the worktree", async () => {
      const scenario = await claudeScenario("mate-cli-e2e-plain-claude-new-worktree-");
      expect((await runMate(scenario, { cwd: scenario.working, args: ["wrap"] })).exitCode).toBe(0);
      runGit(scenario.working, [
        "-c",
        "user.email=mate-e2e@example.com",
        "-c",
        "user.name=Mate E2E",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
      ]);
      /** As T3 Code or `claude --worktree` makes it: Git's files only, no `.mate/` and no `.claude/`. */
      const worktree = path.join(scenario.root, "app-fix");
      runGit(scenario.working, ["worktree", "add", "-q", "-b", "fix", worktree]);
      await expect(fs.access(path.join(worktree, ".mate"))).rejects.toThrow();
      const note = path.join(worktree, "notes", "plan.md");
      const mock = await startMockModelServer((request) =>
        request.body.includes('"tool_result"')
          ? { text: "ok" }
          : { toolUse: { name: "Write", input: { file_path: note, content: "# plan\n" } } },
      );

      try {
        const result = await runPlainClaude(
          scenario,
          worktree,
          ["--print", "write the plan", "--permission-mode", "acceptEdits"],
          mock,
        );

        expect(result.exitCode).toBe(0);
        const blocked = mock.requests.find((request) => request.body.includes('"tool_result"'));
        if (!blocked) throw new Error(`no tool result among ${mock.requests.length} requests`);
        expect(flattenRequest(blocked.body)).toContain(scenario.companion);
        await expect(fs.access(note)).rejects.toThrow();
        const link = parse(await fs.readFile(repoLocalRegistryPath(worktree), "utf8")) as {
          repository: { id: string; path: string };
        };
        expect(link.repository).toEqual({ id: "app", path: await fs.realpath(worktree) });
      } finally {
        await mock.close();
      }
    }, 120_000);

    /**
     * T3 resumes a thread with `--resume`, and the hook fires again there.
     * Claude Code 2.1.309 keeps one copy when the text is unchanged; after the
     * companion `AGENTS.md` changed, the resumed request holds the earlier copy
     * from history plus the current one: the accepted cost of covering
     * conversations that predate the hook.
     */
    test("a resumed plain session records its copy count", async () => {
      const scenario = await claudeScenario("mate-cli-e2e-plain-claude-resume-");
      expect((await runMate(scenario, { cwd: scenario.working, args: ["wrap"] })).exitCode).toBe(0);
      const mock = await startMockModelServer();
      const sessionId = crypto.randomUUID();
      const copiesIn = (prompt: string) => {
        const request = flattenRequest(requestFor(mock, prompt).body);
        return {
          instructions: countOccurrences(request, INSTRUCTIONS_MARKER),
          firstSentinel: countOccurrences(request, USER_SENTINEL),
          resumeSentinel: countOccurrences(request, RESUME_SENTINEL),
        };
      };
      const run = async (args: string[]) =>
        expect((await runPlainClaude(scenario, scenario.working, args, mock)).exitCode).toBe(0);

      try {
        await run(["--print", "--session-id", sessionId, "say hi"]);
        await run(["--print", "--resume", sessionId, "say again"]);
        expect(copiesIn("say again")).toEqual({
          instructions: 1,
          firstSentinel: 1,
          resumeSentinel: 0,
        });

        /** Only a hook that fires on resume can deliver text written after the first run. */
        await fs.appendFile(
          path.join(scenario.companion, "AGENTS.md"),
          `\n## Acme later\n\n- ${RESUME_SENTINEL}\n`,
        );
        await run(["--print", "--resume", sessionId, "say once more"]);
        expect(copiesIn("say once more")).toEqual({
          instructions: 2,
          firstSentinel: 2,
          resumeSentinel: 1,
        });
      } finally {
        await mock.close();
      }
    }, 180_000);

    /** One channel for both launchers: a conversation moved between them holds the current text once. */
    test.each([
      ["mate claude", "claude"],
      ["claude", "mate claude"],
    ] as const)(
      "a conversation started with %s and resumed with %s holds one copy",
      async (first, second) => {
        const scenario = await claudeScenario("mate-cli-e2e-cross-launcher-resume-");
        expect((await runMate(scenario, { cwd: scenario.working, args: ["wrap"] })).exitCode).toBe(
          0,
        );
        const mock = await startMockModelServer();
        const sessionId = crypto.randomUUID();
        const launch = async (launcher: string, args: string[]) => {
          const result =
            launcher === "mate claude"
              ? await runMate(scenario, {
                  cwd: scenario.working,
                  args: ["claude", ...args],
                  input: "y\n",
                  env: mateClaudeEnv(mock),
                })
              : await runPlainClaude(scenario, scenario.working, args, mock);
          expect(result.exitCode).toBe(0);
        };

        try {
          await launch(first, ["--print", "--session-id", sessionId, "say hi"]);
          await fs.appendFile(
            path.join(scenario.companion, "AGENTS.md"),
            `\n## Acme later\n\n- ${RESUME_SENTINEL}\n`,
          );
          await launch(second, ["--print", "--resume", sessionId, "say again"]);

          const body = requestFor(mock, "say again").body;
          expect(countOccurrences(flattenSystemPrompt(body), INSTRUCTIONS_MARKER)).toBe(0);
          expect(countOccurrences(flattenRequest(body), RESUME_SENTINEL)).toBe(1);
        } finally {
          await mock.close();
        }
      },
      240_000,
    );
  },
);

describe.skipIf(!runRealAgentTests || !hasOpenCode)(
  "real opencode agent — system prompt injection",
  () => {
    test("companion guidance markers each appear exactly once in the real system prompt", async () => {
      const scenario = await createScenario("mate-cli-e2e-real-opencode-");
      initWorkingRepoGit(scenario);
      const mock = await startMockModelServer();

      try {
        const setupSelections = { allowedAgents: ["opencode"] };
        expect((await setupCompanion(scenario, setupSelections.allowedAgents)).exitCode).toBe(0);
        expect((await linkRepository(scenario)).exitCode).toBe(0);

        // Pin the provider/model explicitly: opencode silently falls back to its
        // own pre-configured provider if the model isn't pinned, which would
        // bypass the baseURL redirect below entirely (see design doc — this is
        // the exact failure mode from the earlier live-agent incident).
        const providerBaseUrl = mock.baseUrl;
        const openCodeConfigContent = JSON.stringify({
          provider: {
            anthropic: { options: { baseURL: providerBaseUrl } },
            openai: { options: { baseURL: `${providerBaseUrl}/v1` } },
          },
        });

        /**
         * `--standalone`: opencode v2 `run` otherwise attaches to the shared background
         * service on a fixed port, which ignores the isolated HOME and hangs when the
         * user's own service already holds that port.
         */
        const result = await runMate(scenario, {
          cwd: scenario.working,
          args: ["opencode", "run", "--standalone", "-m", OPENCODE_MODEL, "say hi"],
          input: "y\n",
          env: {
            ANTHROPIC_API_KEY: DUMMY_API_KEY,
            OPENAI_API_KEY: DUMMY_API_KEY,
            ANTHROPIC_BASE_URL: providerBaseUrl,
            OPENAI_BASE_URL: `${providerBaseUrl}/v1`,
            OPENCODE_CONFIG_CONTENT: openCodeConfigContent,
          },
        });

        expect(result.exitCode).toBe(0);
        // OpenCode also fires an internal "small model" title-generation
        // request with a much smaller system prompt; filter to the request
        // that used the pinned conversation model to find the real one. The
        // captured `model` field is the bare model id, not the `provider/model`
        // selector string passed to `-m`.
        const mainRequest = mock.requests.find((r) => r.model === OPENCODE_MODEL_ID);
        expect(mainRequest).toBeDefined();
        assertMarkersAppearExactlyOnce(mainRequest!.body);
        expect(
          countOccurrences(flattenSystemPrompt(mainRequest!.body), CONTEXT_MODE_GUIDANCE_MARKER),
        ).toBe(1);
      } finally {
        await mock.close();
      }
    });
  },
);

/** Plain OpenCode in a wrapped repository. */

interface OpenCodeService {
  query(resource: string, directory: string): Promise<unknown>;
  stop(): Promise<void>;
}

/** The scenario's empty Mate environment, as a session the operator starts would see it. */
function plainEnv(scenario: E2EScenario): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: scenario.home,
    PATH: `${scenario.bin}:${process.env.PATH ?? ""}`,
    MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH: "1",
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith("MATE_") && name !== "MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH") {
      delete env[name];
    }
    if (name.startsWith("OPENCODE_") || name.startsWith("XDG_")) delete env[name];
  }
  return env;
}

/** A private `opencode serve` started outside the repository, like the shared background service. */
async function startOpenCodeService(
  scenario: E2EScenario,
  env: NodeJS.ProcessEnv = {},
): Promise<OpenCodeService> {
  const port = 47_000 + Math.floor(Math.random() * 2_000);
  const child = spawn("opencode", ["serve", "--port", String(port)], {
    cwd: scenario.root,
    env: { ...plainEnv(scenario), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const password = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`opencode serve: ${output}`)), 20_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/server password (\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
  });
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  return {
    async query(resource, directory) {
      const url = `http://127.0.0.1:${port}/api/${resource}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
      const response = await fetch(url, { headers: { Authorization: auth } });
      return response.json();
    },
    async stop() {
      child.kill();
      await new Promise((resolve) => child.once("close", resolve));
    },
  };
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling is the point
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for OpenCode");
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function writeGlobalOpenCodeConfig(scenario: E2EScenario): Promise<string> {
  const globalDir = path.join(scenario.home, ".config", "opencode");
  await fs.mkdir(path.join(globalDir, "commands"), { recursive: true });
  await fs.writeFile(
    path.join(globalDir, "commands", "acme-review.md"),
    "---\ndescription: acme review\n---\nreview\n",
  );
  await fs.writeFile(
    path.join(globalDir, "opencode.json"),
    JSON.stringify({ instructions: ["ACME-GLOBAL-MARKER"] }),
  );
  return globalDir;
}

function names(response: unknown): string[] {
  const data = (response as { data?: Array<{ name?: string; id?: string }> }).data ?? [];
  return data.map((entry) => entry.name ?? entry.id ?? "");
}

describe.skipIf(!runRealAgentTests || !hasOpenCode)(
  "real opencode — plain session in a wrapped repository",
  () => {
    test("a shared service started elsewhere loads global config, companion content and prepares", async () => {
      const scenario = await createScenario("mate-cli-e2e-plain-opencode-");
      initWorkingRepoGit(scenario);
      expect((await setupCompanion(scenario, ["opencode"])).exitCode).toBe(0);
      expect((await linkRepository(scenario)).exitCode).toBe(0);
      await writeGlobalOpenCodeConfig(scenario);
      await fs.mkdir(path.join(scenario.companion, ".opencode", "commands"), { recursive: true });
      await fs.writeFile(
        path.join(scenario.companion, ".opencode", "commands", "acme-wrapped.md"),
        "---\ndescription: acme wrapped\n---\nwrapped\n",
      );
      const wrap = await runMate(scenario, { cwd: scenario.working, args: ["wrap"] });
      expect(wrap.exitCode).toBe(0);
      /** Not copied by the wrap: only the plugin's prepare can deliver it. */
      await fs.writeFile(
        path.join(scenario.companion, ".opencode", "commands", "acme-late.md"),
        "---\ndescription: acme late\n---\nlate\n",
      );

      const service = await startOpenCodeService(scenario);
      try {
        const commands = await waitFor(async () => {
          const listed = names(await service.query("command", scenario.working));
          return listed.includes("acme-late") ? listed : undefined;
        });
        expect(commands).toContain("acme-review");
        expect(commands).toContain("acme-wrapped");

        const skills = names(await service.query("skill", scenario.working));
        /** A copied companion skill and one from the companion's `.agents/skills` path. */
        expect(skills).toContain("graphify");
        expect(skills).toContain("mate-grill-me");

        const sources = (await service.query("config", scenario.working)) as Array<{
          type: string;
          path: string;
        }>;
        expect(sources.map((source) => source.path)).toContain(
          path.join(scenario.home, ".config", "opencode"),
        );

        const mcp = (await service.query("mcp", scenario.working)) as {
          data?: Array<{ name: string; status: { status: string } }>;
        };
        for (const server of mcp.data ?? []) {
          expect(server.status.status).not.toBe("disabled");
        }
      } finally {
        await service.stop();
      }
    });

    test("setup returns after the local phase while the remote is still unreachable", async () => {
      const scenario = await createScenario("mate-cli-e2e-plain-opencode-offline-");
      initWorkingRepoGit(scenario);
      expect((await setupCompanion(scenario, ["opencode"], ["--git-mode", "auto"])).exitCode).toBe(
        0,
      );
      expect((await linkRepository(scenario)).exitCode).toBe(0);
      const { remote } = gitBackedCompanion(scenario);
      /** A remote that hangs: only the background sync may wait on it. */
      runGit(scenario.companion, ["remote", "set-url", "origin", stubSshUrl(remote)]);
      const ssh = makeSshStub(scenario.root).env("slow");
      const sshEnv = Object.fromEntries(
        Object.entries(ssh).filter(([name]) => /^(GIT_|MATE_TEST_SSH_)/.test(name)),
      );
      expect((await runMate(scenario, { cwd: scenario.working, args: ["wrap"] })).exitCode).toBe(0);
      await fs.mkdir(path.join(scenario.companion, ".opencode", "commands"), { recursive: true });
      await fs.writeFile(
        path.join(scenario.companion, ".opencode", "commands", "acme-late.md"),
        "---\ndescription: acme late\n---\nlate\n",
      );

      const service = await startOpenCodeService(scenario, sshEnv);
      try {
        await waitFor(async () =>
          names(await service.query("command", scenario.working)).includes("acme-late")
            ? true
            : undefined,
        );
        /** The local phase is in, and the fetch has not even given up yet. */
        expect(readCompanionGitRecord(scenario.companion, scenario.home).unfinishedReason).toBe(
          undefined,
        );

        const reason = await waitFor(
          async () => readCompanionGitRecord(scenario.companion, scenario.home).unfinishedReason,
          45_000,
        );
        expect(reason).toContain("fetch");
      } finally {
        await service.stop();
      }
    }, 90_000);

    test("a background sync delivers an upstream command to the running session", async () => {
      const scenario = await createScenario("mate-cli-e2e-plain-opencode-sync-");
      initWorkingRepoGit(scenario);
      expect((await setupCompanion(scenario, ["opencode"], ["--git-mode", "auto"])).exitCode).toBe(
        0,
      );
      expect((await linkRepository(scenario)).exitCode).toBe(0);
      const { upstream } = gitBackedCompanion(scenario);
      expect((await runMate(scenario, { cwd: scenario.working, args: ["wrap"] })).exitCode).toBe(0);
      /** Upstream only: the awaited local phase cannot see it, only the sync can. */
      await fs.mkdir(path.join(upstream, ".opencode", "commands"), { recursive: true });
      await fs.writeFile(
        path.join(upstream, ".opencode", "commands", "acme-upstream.md"),
        "---\ndescription: acme upstream\n---\nupstream\n",
      );
      runGit(upstream, ["add", ".opencode/commands/acme-upstream.md"]);
      runGit(upstream, ["commit", "-qm", "acme upstream command"]);
      runGit(upstream, ["push", "-q"]);

      const service = await startOpenCodeService(scenario);
      try {
        await waitFor(async () =>
          names(await service.query("command", scenario.working)).includes("acme-upstream")
            ? true
            : undefined,
        );
        await expect(
          fs.access(path.join(scenario.working, ".opencode", "commands", "acme-upstream.md")),
        ).resolves.toBeNull();
      } finally {
        await service.stop();
      }
    }, 90_000);

    test("mate opencode keeps the global OpenCode config", async () => {
      const scenario = await createScenario("mate-cli-e2e-global-opencode-");
      initWorkingRepoGit(scenario);
      expect((await setupCompanion(scenario, ["opencode"])).exitCode).toBe(0);
      expect((await linkRepository(scenario)).exitCode).toBe(0);
      const globalDir = await writeGlobalOpenCodeConfig(scenario);

      const result = await runMate(scenario, {
        cwd: scenario.working,
        args: ["opencode", "debug", "paths"],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(globalDir);
      expect(result.stdout).not.toContain(path.join(scenario.companion, ".opencode"));
    });
  },
);

/**
 * Spike for `share-repository-link-across-worktrees` (design Decision 1): what
 * a real Claude Code reads in a linked worktree. Every layout carries a marker
 * hook in each candidate `settings.local.json`, an MCP server under each
 * folder's `~/.claude.json` entry and a skill only in the main worktree. The
 * assertions pin the outcome recorded in the design, so a Claude Code release
 * that changes it fails here first.
 */

interface SpikeHookRun {
  marker: string;
  projectDir: string | null;
  inputCwd: string | null;
}

const SPIKE_MCP_SERVER = [
  "#!/usr/bin/env bun",
  "// The smallest stdio MCP server: one tool, newline-delimited JSON-RPC.",
  "let buffer = '';",
  "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk.toString();",
  "  let newline;",
  "  while ((newline = buffer.indexOf('\\n')) >= 0) {",
  "    const line = buffer.slice(0, newline).trim();",
  "    buffer = buffer.slice(newline + 1);",
  "    if (!line) continue;",
  "    const request = JSON.parse(line);",
  "    if (request.id === undefined) continue;",
  "    if (request.method === 'initialize') {",
  "      send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'spike', version: '1.0.0' } } });",
  "    } else if (request.method === 'tools/list') {",
  "      send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'ping', description: 'spike ping', inputSchema: { type: 'object', properties: {} } }] } });",
  "    } else {",
  "      send({ jsonrpc: '2.0', id: request.id, result: {} });",
  "    }",
  "  }",
  "});",
  "",
].join("\n");

const SPIKE_HOOK = [
  "#!/usr/bin/env bun",
  'import fs from "node:fs";',
  "const [log, marker] = process.argv.slice(2);",
  "let input = {};",
  "try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}",
  "fs.appendFileSync(log, JSON.stringify({ marker, projectDir: process.env.CLAUDE_PROJECT_DIR ?? null, inputCwd: typeof input.cwd === 'string' ? input.cwd : null }) + '\\n');",
  "",
].join("\n");

interface SpikeKit {
  root: string;
  hookLog: string;
  hookScript: string;
  mcpScript: string;
}

async function spikeKit(scenario: E2EScenario): Promise<SpikeKit> {
  const kit = {
    root: scenario.root,
    hookLog: path.join(scenario.root, "spike-hooks.log"),
    hookScript: path.join(scenario.root, "spike-hook.ts"),
    mcpScript: path.join(scenario.root, "spike-mcp.ts"),
  };
  await fs.writeFile(kit.hookScript, SPIKE_HOOK, "utf8");
  await fs.writeFile(kit.mcpScript, SPIKE_MCP_SERVER, "utf8");
  return kit;
}

/** A SessionStart hook that logs `marker`, in `folder`'s `.claude/settings.local.json`. */
async function writeMarkerHook(kit: SpikeKit, folder: string, marker: string): Promise<void> {
  const settings = path.join(folder, ".claude", "settings.local.json");
  await fs.mkdir(path.dirname(settings), { recursive: true });
  const command = `bun ${kit.hookScript} ${kit.hookLog} ${marker}`;
  await fs.writeFile(
    settings,
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }),
    "utf8",
  );
}

async function writeMainSkill(folder: string): Promise<void> {
  const skill = path.join(folder, ".claude", "skills", "spike-main-skill", "SKILL.md");
  await fs.mkdir(path.dirname(skill), { recursive: true });
  await fs.writeFile(
    skill,
    "---\nname: spike-main-skill\ndescription: Spike skill that only the main worktree holds.\n---\nspike\n",
    "utf8",
  );
}

/** `~/.claude.json` with one MCP server per folder, named after it. */
async function writeSpikeClaudeJson(
  scenario: E2EScenario,
  kit: SpikeKit,
  servers: Record<string, string>,
): Promise<void> {
  const projects = Object.fromEntries(
    Object.entries(servers).map(([folder, name]) => [
      folder,
      {
        hasTrustDialogAccepted: true,
        mcpServers: { [name]: { type: "stdio", command: "bun", args: [kit.mcpScript] } },
      },
    ]),
  );
  await fs.writeFile(
    path.join(scenario.home, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, projects }),
    "utf8",
  );
}

async function readSpikeHookRuns(kit: SpikeKit): Promise<SpikeHookRun[]> {
  const raw = await fs.readFile(kit.hookLog, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SpikeHookRun);
}

function gitInRoot(cwd: string, args: string[]): void {
  runGit(cwd, ["-c", "user.email=spike@example.com", "-c", "user.name=Spike", ...args]);
}

interface SpikeObservation {
  hooks: SpikeHookRun[];
  mcpServers: string[];
  skillListed: boolean;
}

async function observeSpike(
  scenario: E2EScenario,
  kit: SpikeKit,
  cwd: string,
  args: string[],
  serverNames: string[],
): Promise<SpikeObservation> {
  await fs.rm(kit.hookLog, { force: true });
  const mock = await startMockModelServer();
  try {
    const result = await runPlainClaude(scenario, cwd, [...args, "--print", "spike hi"], mock);
    expect(result.exitCode).toBe(0);
    const body = requestFor(mock, "spike hi").body;
    return {
      hooks: await readSpikeHookRuns(kit),
      mcpServers: serverNames.filter((name) => body.includes(`mcp__${name}__`)),
      skillListed: body.includes("spike-main-skill"),
    };
  } finally {
    await mock.close();
  }
}

describe.skipIf(!runRealAgentTests || !hasClaude)(
  "real claude agent — worktree spike (share-repository-link-across-worktrees)",
  () => {
    test("Claude Code reads a linked worktree's local settings and skills from the main worktree", async () => {
      const scenario = await createScenario("mate-cli-e2e-spike-worktrees-");
      const kit = await spikeKit(scenario);
      const main = scenario.working;
      gitInRoot(scenario.root, ["init", "-q", "--initial-branch=main", main]);
      gitInRoot(main, ["commit", "-q", "--allow-empty", "-m", "init"]);
      const sibling = path.join(scenario.root, "app-sibling");
      const nested = path.join(main, ".claude", "worktrees", "nest");
      gitInRoot(main, ["worktree", "add", "-q", "--detach", sibling]);
      gitInRoot(main, ["worktree", "add", "-q", "--detach", nested]);
      await writeMarkerHook(kit, main, "main");
      await writeMarkerHook(kit, sibling, "sibling");
      await writeMainSkill(main);

      const bareRoot = path.join(scenario.root, "bare");
      await fs.mkdir(bareRoot);
      const bare = path.join(bareRoot, "acme.git");
      gitInRoot(scenario.root, ["clone", "-q", "--bare", main, bare]);
      const bareA = path.join(bareRoot, "acme-a");
      const bareB = path.join(bareRoot, "acme-b");
      gitInRoot(bare, ["worktree", "add", "-q", "--detach", bareA]);
      gitInRoot(bare, ["worktree", "add", "-q", "--detach", bareB]);
      await writeMarkerHook(kit, bare, "bare-dir");
      await writeMarkerHook(kit, bareA, "bare-a");
      await writeMarkerHook(kit, bareB, "bare-b");
      await writeMainSkill(bareA);

      const servers: Record<string, string> = {
        [main]: "spike-main",
        [sibling]: "spike-sibling",
        [nested]: "spike-nested",
        [bare]: "spike-bare-dir",
        [bareA]: "spike-bare-a",
        [bareB]: "spike-bare-b",
      };
      await writeSpikeClaudeJson(scenario, kit, servers);
      const names = Object.values(servers);

      /** Nested: its own settings file too, written after the sibling run left only the main's. */
      const siblingRun = await observeSpike(scenario, kit, sibling, [], names);
      const nestedBare = await observeSpike(scenario, kit, nested, [], names);
      await writeMarkerHook(kit, nested, "nested");
      const nestedRun = await observeSpike(scenario, kit, nested, [], names);
      const bareRun = await observeSpike(scenario, kit, bareB, [], names);
      const flagRun = await observeSpike(scenario, kit, main, ["--worktree", "spike-flag"], names);
      const flagFolder = path.join(main, ".claude", "worktrees", "spike-flag");

      const report = {
        claudeVersion: spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim(),
        sibling: siblingRun,
        nestedWithoutOwnSettings: nestedBare,
        nestedWithOwnSettings: nestedRun,
        bareWorktree: bareRun,
        worktreeFlag: { ...flagRun, folder: flagFolder },
        layout: { main, sibling, nested, bare, bareA, bareB },
      };
      console.log(`WORKTREE-SPIKE ${JSON.stringify(report, null, 2)}`);

      const markers = (observation: SpikeObservation) =>
        observation.hooks.map((run) => run.marker).toSorted();
      /**
       * Outcome C: a linked worktree of a non-bare clone loads the main
       * worktree's local settings and its own, so a hook both carry runs twice.
       */
      expect(markers(siblingRun)).toEqual(["main", "sibling"]);
      expect(markers(nestedBare)).toEqual(["main"]);
      expect(markers(nestedRun)).toEqual(["main", "nested"]);
      expect(markers(flagRun)).toEqual(["main"]);
      /** A bare repository's worktree loads its own file only. */
      expect(markers(bareRun)).toEqual(["bare-b"]);
      /** The hook input's `cwd` and `CLAUDE_PROJECT_DIR` name the worktree, `--worktree` included. */
      for (const [observation, folder] of [
        [siblingRun, sibling],
        [nestedRun, nested],
        [bareRun, bareB],
        [flagRun, flagFolder],
      ] as const) {
        for (const run of observation.hooks) {
          expect(run.inputCwd).toBe(folder);
          expect(run.projectDir).toBe(folder);
        }
      }
      /** MCP servers come from the main worktree's entry; for a bare clone, the bare folder's. */
      expect(siblingRun.mcpServers).toEqual(["spike-main"]);
      expect(nestedRun.mcpServers).toEqual(["spike-main"]);
      expect(bareRun.mcpServers).toEqual(["spike-bare-dir"]);
      /** Skills read through to the main worktree when the worktree has no `.claude/skills`. */
      expect(siblingRun.skillListed).toBe(true);
      expect(nestedRun.skillListed).toBe(true);
      expect(bareRun.skillListed).toBe(false);
    }, 240_000);
  },
);
