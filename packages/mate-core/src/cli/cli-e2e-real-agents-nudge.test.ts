import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// Local-only, opt-in verification that the archive-finish nudge fires for a
// REAL archived OpenSpec change, driven by the actual `claude` and `opencode`
// binaries against a scripted mock model server (no real network request or
// model call). Sibling to cli-e2e-real-agents.test.ts, deliberately
// self-contained (duplicates the small subset of its scenario plumbing it
// needs) for the same reason that file gives for not importing from
// cli-e2e.test.ts: keeping each real-binary suite decoupled from the others.
//
// Claude's archive-finish nudge (packages/mate-core/src/hooks/artifact-finish-nudge.ts)
// is a PostToolUse hook that statically parses the Bash command text and
// emits `additionalContext` on the tool call's own hook response. OpenCode's
// (packages/mate-core/src/opencode/companion-hooks.ts) is a DIFFERENT
// mechanism — it snapshots `openspec/changes/archive/` before each tool call
// and diffs it after, independent of the command text — and appends its own
// differently-worded nudge directly to the tool's output. Each agent's test
// below asserts on that agent's actual wording.
//
// Gating: skipped entirely whenever `CI` is set, and skipped per-tool when
// the real `claude`/`opencode` binary isn't resolvable on PATH locally.

const APP_ROOT = path.resolve(import.meta.dirname, "../../../../apps/mate-cli");
const E2E_TMP_ROOT = path.join(os.tmpdir(), "mate-cli-e2e");
const tempRoots: string[] = [];

const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const RUN_MATE_WATCHDOG_MS = 45_000;
setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);

const DUMMY_API_KEY = "sk-ant-dummy-test-key";
const OPENCODE_MODEL = "anthropic/claude-sonnet-4-5";
const OPENCODE_MODEL_ID = "claude-sonnet-4-5";

// Sanitized placeholder change name, per repo convention.
const CHANGE_NAME = "acme";
const DATED_ENTRY = `2099-01-01-${CHANGE_NAME}`;

// Builds the change directly through shell variables (TARGET -> DEST -> mv
// "$DEST") rather than a literal path — the exact shape that missed Claude's
// nudge before the variable-substitution fix in artifact-finish-nudge.ts.
//
// Uses the COMPANION's absolute path, not a path relative to the working
// repo cwd: OpenCode's archive-finish nudge (companion-hooks.ts) watches
// `<companionPath>/openspec/changes/archive` via filesystem diffing, which
// is a different absolute directory than the working repo entirely — this
// mirrors how openspec changes actually live in the companion in real usage.
function buildArchiveCommand(companionPath: string): string {
  const changesDir = `${companionPath}/openspec/changes`;
  return [
    `mkdir -p "${changesDir}/${CHANGE_NAME}-src" "${changesDir}/archive"`,
    `TARGET="${DATED_ENTRY}"`,
    `DEST="${changesDir}/archive/$TARGET"`,
    `mv "${changesDir}/${CHANGE_NAME}-src" "$DEST"`,
  ].join("\n");
}

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

const isCI = Boolean(process.env.CI);
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
  await fs.writeFile(
    path.join(updateDir, "update-state-uniqbit-mate.yaml"),
    ["lastChecked: 2099-01-01T00:00:00.000Z", "latestVersion: null", ""].join("\n"),
    "utf8",
  );
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
    const child = spawn("bun", [path.join(APP_ROOT, "src/cli.ts"), ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: scenario.home,
        // Isolate zsh's unconditional `.zshenv` load from the real developer
        // machine's dotfiles: the agent's Bash tool spawns a real shell for
        // every command, and a personal `.zshenv` sourcing something under
        // the real $HOME (e.g. `.cargo/env`) can abort the script before it
        // ever reaches the archive command this suite depends on executing.
        ZDOTDIR: scenario.home,
        PATH: `${scenario.bin}:${process.env.PATH ?? ""}`,
        TERM_PROGRAM: "",
        VSCODE_IPC_HOOK: "",
        __CFBundleIdentifier: "",
        CI: "", // unset so piped stdin ("y\n") is read normally in the spawned process
        MATE_ARTIFACT_PATH: "",
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
  const command = ["bun", path.join(APP_ROOT, "src/cli.ts"), ...args].map(toTclString).join(" ");
  const sends = inputChunks
    .map((entry) => {
      const step = typeof entry === "string" ? { chunk: entry } : entry;
      return [`after ${step.delayMs ?? 150}`, `send -- ${toTclString(step.chunk)}`].join("\n");
    })
    .join("\n");
  const expectScript = [
    `set timeout ${timeoutSeconds ?? 8}`,
    "log_user 1",
    `spawn -noecho ${command}`,
    sends,
    "expect { eof { set result [wait]; exit [lindex $result 3] } timeout { exit 124 } }",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn("expect", ["-c", expectScript], {
      cwd,
      env: {
        ...process.env,
        HOME: scenario.home,
        PATH: `${scenario.bin}:${process.env.PATH ?? ""}`,
        TERM_PROGRAM: "",
        VSCODE_IPC_HOOK: "",
        __CFBundleIdentifier: "",
        CI: "",
        MATE_ARTIFACT_PATH: "",
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
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
    child.stdin.end();
  });
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

// The nudge's gate needs both MATE_OPENSPEC_ENABLED (the `openspec`
// capability) and MATE_GIT_AUTO_MODE — the latter is NOT on by default
// (config.git stays unset unless requested), so `--git-mode auto` must be
// passed explicitly.
async function setupCompanion(
  scenario: E2EScenario,
  allowedAgents: string[],
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
      "--git-mode",
      "auto",
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
  spawn("git", ["init", "-q"], { cwd: scenario.working, stdio: "ignore" });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// ---- scripted mock model server ----
//
// Unlike cli-e2e-real-agents.test.ts's static "always reply hi" server, this
// one needs a real two-turn round trip: first reply is a scripted tool_use
// instructing the CLI to run ARCHIVE_COMMAND for real (so the actual
// installed hook/plugin fires), second reply ends the turn once the tool
// result comes back.

interface CapturedRequest {
  url: string;
  body: string;
  model: string | null;
}

interface ScriptedMockModelServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

type SseFrame = [event: string, data: unknown];

function toolUseFrames(toolName: string, command: string): SseFrame[] {
  return [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_mock_tool",
          type: "message",
          role: "assistant",
          model: "mock-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_scripted_archive",
          name: toolName,
          input: {},
        },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ command }) },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}

function textFrames(text: string): SseFrame[] {
  return [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_mock_final",
          type: "message",
          role: "assistant",
          model: "mock-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}

// A nudge sentence gets embedded as a JSON string VALUE inside the raw HTTP
// body (the tool_result content, or the assistant's echoed prior turn) —
// its own literal quote characters come out backslash-escaped there, unlike
// a plain JS string comparison.
function jsonEscaped(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

function hasToolResult(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    const content = (message as { content?: unknown })?.content;
    return (
      Array.isArray(content) &&
      content.some((block) => (block as { type?: string })?.type === "tool_result")
    );
  });
}

// Scripts exactly one tool_use turn per matching ("primary model") request
// stream that hasn't already seen a tool_result, then falls back to a plain
// end_turn reply — for both the primary conversation's follow-up turn and
// any unrelated request (e.g. OpenCode's internal title-generation call).
async function startScriptedMockModelServer(opts: {
  toolName: string;
  toolCommand: string;
  isPrimaryModel: (model: string | null) => boolean;
}): Promise<ScriptedMockModelServer> {
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
      let messages: unknown;
      try {
        const parsed = JSON.parse(raw) as { stream?: boolean; model?: string; messages?: unknown };
        streaming = parsed.stream === true;
        model = typeof parsed.model === "string" ? parsed.model : null;
        messages = parsed.messages;
      } catch {
        // non-JSON body; fall through to the plain-text reply below
      }

      requests.push({ url: req.url ?? "", body: raw, model });

      const shouldCallTool = opts.isPrimaryModel(model) && !hasToolResult(messages);
      const frames = shouldCallTool
        ? toolUseFrames(opts.toolName, opts.toolCommand)
        : textFrames("done");

      if (streaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        for (const [event, data] of frames) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            shouldCallTool
              ? {
                  id: "msg_mock_tool",
                  type: "message",
                  role: "assistant",
                  model: "mock-model",
                  content: [
                    {
                      type: "tool_use",
                      id: "toolu_scripted_archive",
                      name: opts.toolName,
                      input: { command: opts.toolCommand },
                    },
                  ],
                  stop_reason: "tool_use",
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                }
              : {
                  id: "msg_mock_final",
                  type: "message",
                  role: "assistant",
                  model: "mock-model",
                  content: [{ type: "text", text: "done" }],
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
          ),
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

describe.skipIf(isCI || !hasClaude)("real claude agent — archive-finish nudge", () => {
  test("nudges to run mate artifact finish after a real archive mv through shell variables", async () => {
    const scenario = await createScenario("mate-cli-e2e-real-claude-nudge-");
    initWorkingRepoGit(scenario);
    const mock = await startScriptedMockModelServer({
      toolName: "Bash",
      toolCommand: buildArchiveCommand(scenario.companion),
      isPrimaryModel: () => true,
    });

    try {
      expect((await setupCompanion(scenario, ["claude"])).exitCode).toBe(0);
      expect((await linkRepository(scenario)).exitCode).toBe(0);

      const result = await runMate(scenario, {
        cwd: scenario.working,
        args: ["claude", "--print", "--dangerously-skip-permissions", "archive the change"],
        input: "y\n",
        env: {
          ANTHROPIC_API_KEY: DUMMY_API_KEY,
          ANTHROPIC_BASE_URL: mock.baseUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(mock.requests.length).toBeGreaterThan(1);
      const followUp = mock.requests[1]!.body;
      // The real nudge names the concrete change ("acme"), unlike the
      // generic `<name>` placeholder that companion guidance's static
      // openspec-finish rule text always carries in every request.
      expect(followUp).toContain(`OpenSpec change ${CHANGE_NAME} was just archived`);
      expect(followUp).toContain(jsonEscaped(`mate artifact finish "${CHANGE_NAME}" --json`));
    } finally {
      await mock.close();
    }
  });
});

describe.skipIf(isCI || !hasOpenCode)("real opencode agent — archive-finish nudge", () => {
  test("nudges to run mate artifact finish after a real archive mv through shell variables", async () => {
    const scenario = await createScenario("mate-cli-e2e-real-opencode-nudge-");
    initWorkingRepoGit(scenario);
    const mock = await startScriptedMockModelServer({
      toolName: "bash",
      toolCommand: buildArchiveCommand(scenario.companion),
      isPrimaryModel: (model) => model === OPENCODE_MODEL_ID,
    });

    try {
      expect((await setupCompanion(scenario, ["opencode"])).exitCode).toBe(0);
      expect((await linkRepository(scenario)).exitCode).toBe(0);

      const providerBaseUrl = mock.baseUrl;
      const openCodeConfigContent = JSON.stringify({
        provider: {
          anthropic: { options: { baseURL: providerBaseUrl } },
          openai: { options: { baseURL: `${providerBaseUrl}/v1` } },
        },
      });

      const result = await runMate(scenario, {
        cwd: scenario.working,
        args: [
          "opencode",
          "run",
          "-m",
          OPENCODE_MODEL,
          "--auto",
          "--dir",
          scenario.working,
          "archive the change",
        ],
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
      // Filter out OpenCode's internal title-generation request the same way
      // cli-e2e-real-agents.test.ts does — it uses a different model.
      const mainRequests = mock.requests.filter((r) => r.model === OPENCODE_MODEL_ID);
      expect(mainRequests.length).toBeGreaterThan(1);
      const followUp = mainRequests[1]!.body;
      expect(followUp).toContain(`An openspec change (${CHANGE_NAME}) was just archived`);
      expect(followUp).toContain("Immediately invoke the mate-artifact-finish skill");
    } finally {
      await mock.close();
    }
  });
});
