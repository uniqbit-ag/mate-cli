import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parse } from "yaml";

const APP_ROOT = path.resolve(import.meta.dirname, "../..");
const E2E_TMP_ROOT = path.join(os.tmpdir(), "mate-cli-e2e");
const tempRoots: string[] = [];

// Every test here spawns the CLI entrypoint two or three times in sequence. A
// cold Bun start is ~150ms unloaded, but under the parallel load of the whole
// suite it spikes many-fold — enough for a multi-spawn test to blow past Bun's
// 5s default per-test timeout and fail intermittently. Give the entire file a
// generous default; individual tests still override with tighter values where
// a fast failure is the point.
const DEFAULT_TEST_TIMEOUT_MS = 30_000;
// Watchdog for non-TTY CLI runs. A hung child (e.g. blocked on
// stdin that never arrives) would otherwise sit until the test timeout with no
// diagnostics; killing it early surfaces the captured output instead.
const RUN_MATE_WATCHDOG_MS = 20_000;
setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

interface SetupSelectionFixture {
  allowedAgents?: string[];
  packageManagers?: string[];
  capabilities?: string[];
  openspecSchema?: "mate-v1" | "default";
}

// Returns a PATH string with any directory containing the given command removed.
function pathWithoutCommand(command: string, pathEnv: string): string {
  return pathEnv
    .split(path.delimiter)
    .filter((dir) => {
      if (!dir) return false;
      try {
        accessSync(path.join(dir, command), constants.X_OK);
        return false;
      } catch {
        return true;
      }
    })
    .join(path.delimiter);
}

async function makeTempDir(prefix: string): Promise<string> {
  await fs.mkdir(E2E_TMP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(E2E_TMP_ROOT, prefix));
  tempRoots.push(dir);
  return dir;
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

async function createSetupProvidersRoot(
  scenario: E2EScenario,
  { includeOpenCodePlugin = true }: { includeOpenCodePlugin?: boolean } = {},
): Promise<string> {
  const root = path.join(scenario.root, "setup-providers");
  const opencodePluginsDir = path.join(root, "opencode", "plugins");
  await fs.mkdir(opencodePluginsDir, { recursive: true });
  await fs.copyFile(
    path.join(APP_ROOT, "src", "templates", "providers", "opencode", "opencode.json"),
    path.join(root, "opencode", "opencode.json"),
  );
  await fs.copyFile(
    path.join(APP_ROOT, "src", "templates", "providers", "opencode", "tui.json"),
    path.join(root, "opencode", "tui.json"),
  );

  if (includeOpenCodePlugin) {
    await fs.copyFile(
      path.join(
        APP_ROOT,
        "src",
        "templates",
        "providers",
        "opencode",
        "plugins",
        "mate-companion.ts",
      ),
      path.join(opencodePluginsDir, "mate-companion.ts"),
    );
    await fs.copyFile(
      path.join(
        APP_ROOT,
        "src",
        "templates",
        "providers",
        "opencode",
        "plugins",
        "mate-companion-policy.ts",
      ),
      path.join(opencodePluginsDir, "mate-companion-policy.ts"),
    );
    await fs.copyFile(
      path.join(
        APP_ROOT,
        "src",
        "templates",
        "providers",
        "opencode",
        "plugins",
        "mate-add-dir.ts",
      ),
      path.join(opencodePluginsDir, "mate-add-dir.ts"),
    );
  }

  return root;
}

async function seedUpdateState(home: string): Promise<void> {
  const updateDir = path.join(home, ".mate");
  await fs.mkdir(updateDir, { recursive: true });
  await fs.writeFile(
    path.join(updateDir, "update-state.yaml"),
    ["lastChecked: 2099-01-01T00:00:00.000Z", "latestVersion: null", ""].join("\n"),
    "utf8",
  );
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
        PATH: `${scenario.bin}:${process.env.PATH ?? ""}`,
        TERM_PROGRAM: "",
        VSCODE_IPC_HOOK: "",
        __CFBundleIdentifier: "",
        CI: "", // unset so piped stdin ("y\n") is read normally in spawned processes
        // Prevent dev-environment contamination when running tests inside a Mate-managed agent session
        MATE_ARTIFACT_PATH: "",
        MATE_REPO_ID: "",
        MATE_REPO_PATH: "",
        MATE_REPO_PROFILE: "",
        MATE_POLICY_JSON: "",
        ...env,
      },
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const watchdog = setTimeout(() => {
      if (settled) {
        return;
      }
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
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });

    // A closed/killed child can make the stdin write throw EPIPE; swallow it so
    // the real failure (surfaced via close/watchdog) is what the test sees.
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
  // Ink renders through the alternate-screen buffer, so the wizard's frames do
  // not reach expect until the PTY drains at exit. Real-time `expect <pattern>`
  // matching therefore cannot gate the interaction; instead each chunk is sent
  // after a fixed `delayMs`, timed so the wizard has mounted (and, for the final
  // step, resolved its async preview) before the key arrives.
  const sends = inputChunks
    .map((entry) => {
      const step = typeof entry === "string" ? { chunk: entry } : entry;
      return [`after ${step.delayMs ?? 150}`, `send -- ${toTclString(step.chunk)}`].join("\n");
    })
    .join("\n");
  // NOTE: gating the send schedule on early PTY output does NOT work here —
  // this expect build buffers every Ink frame until the PTY drains at exit, so
  // no byte is observable mid-run to sync against (verified empirically). The
  // fixed `delayMs` clocks below are therefore the only workable mechanism;
  // keep them generous enough to absorb Bun cold start under parallel load.
  //
  // log_user 1 streams the full PTY transcript to stdout, so the caller's
  // captured stdout carries every wizard screen. After the interactions we wait
  // for the child to close the PTY: a clean self-exit yields eof (exit 0), while
  // a hang trips the timeout branch (exit 124) so a process that fails to
  // terminate still fails the test. We deliberately avoid the `wait` builtin —
  // it blocks indefinitely on this expect build once the child is reaped at eof.
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
        MATE_REPO_PROFILE: "",
        MATE_POLICY_JSON: "",
        ...env,
      },
      stdio: "pipe",
    });

    let output = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: output,
        stderr,
      });
    });

    child.stdin.end();
  });
}

async function setupCompanion(
  scenario: E2EScenario,
  extraArgs: string[] = [],
  selections: SetupSelectionFixture = {
    allowedAgents: ["claude"],
    capabilities: ["openspec", "react-doctor"],
  },
  env?: NodeJS.ProcessEnv,
): Promise<CliRunResult> {
  // uv is locked into every setup configuration, so always stub it out
  await writeUvStub(scenario);
  if ((selections.capabilities ?? []).includes("openspec")) {
    await writeOpenSpecStub(scenario);
  }
  const hasHeadroom =
    (selections.capabilities ?? []).includes("headroom") || extraArgs.includes("headroom");
  if (hasHeadroom) {
    await writeHeadroomStub(scenario);
  }
  // Always write rtk stub since launch tests may use --headroom
  await writeRtkStub(scenario);
  if ((selections.capabilities ?? []).includes("graphify")) {
    await writeGraphifyStub(scenario);
  }
  if ((selections.capabilities ?? []).includes("tokensave")) {
    await writeTokensaveInstallStub(scenario);
  }

  const selectionArgs = [
    ...(selections.allowedAgents ?? []).flatMap((agent) => ["--allowed-agent", agent]),
    ...(selections.packageManagers ?? []).flatMap((packageManager) => [
      "--package-manager",
      packageManager,
    ]),
    ...(selections.capabilities ?? []).flatMap((capability) => ["--capability", capability]),
    ...(selections.openspecSchema ? ["--openspec-schema", selections.openspecSchema] : []),
  ];

  return runMate(scenario, {
    cwd: scenario.companion,
    args: ["companion", "setup", ...selectionArgs, ...extraArgs],
    input: "y\n",
    env,
  });
}

async function installCompanion(scenario: E2EScenario): Promise<CliRunResult> {
  return runMate(scenario, {
    cwd: scenario.companion,
    args: ["install", "--yes"],
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
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function initCompanionGit(scenario: E2EScenario): Promise<string> {
  const remote = path.join(scenario.root, "companion-origin.git");
  runGit(scenario.root, ["init", "--bare", "-q", "--initial-branch=main", remote]);
  runGit(scenario.companion, ["init", "-q", "--initial-branch=main"]);
  runGit(scenario.companion, ["config", "user.email", "mate-e2e@example.com"]);
  runGit(scenario.companion, ["config", "user.name", "Mate E2E"]);
  runGit(scenario.companion, ["add", "."]);
  runGit(scenario.companion, ["commit", "-qm", "initial companion state"]);
  runGit(scenario.companion, ["remote", "add", "origin", remote]);
  runGit(scenario.companion, ["push", "-q", "-u", "origin", "main"]);
  return remote;
}

async function writeAdapterStub(
  scenario: E2EScenario,
  toolName: "claude" | "opencode",
): Promise<string> {
  const capturePath = path.join(scenario.root, `${toolName}-capture.json`);
  const stubPath = path.join(scenario.bin, toolName);
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    "const capturePath = process.env.MATE_E2E_CAPTURE_PATH;",
    "if (!capturePath) process.exit(2);",
    "const payload = {",
    `  tool: "${toolName}",`,
    "  cwd: process.cwd(),",
    "  argv: process.argv.slice(2),",
    "  env: {",
    "    GRAPHIFY_OUT: process.env.GRAPHIFY_OUT ?? null,",
    "    MATE_ARTIFACT_PATH: process.env.MATE_ARTIFACT_PATH ?? null,",
    "    MATE_REPO_ID: process.env.MATE_REPO_ID ?? null,",
    "    MATE_REPO_PATH: process.env.MATE_REPO_PATH ?? null,",
    "    MATE_REPO_PROFILE: process.env.MATE_REPO_PROFILE ?? null,",
    "    MATE_POLICY_JSON: process.env.MATE_POLICY_JSON ?? null,",
    "    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR ?? null,",
    "    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,",
    "    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? null,",
    "    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null,",
    "    PATH: process.env.PATH ?? null,",
    "  },",
    "};",
    "fs.writeFileSync(capturePath, JSON.stringify(payload, null, 2));",
    "",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);

  return capturePath;
}

async function writeEditorStub(
  scenario: E2EScenario,
  toolName: "code" | "cursor",
): Promise<string> {
  const capturePath = path.join(scenario.root, `${toolName}-capture.json`);
  const stubPath = path.join(scenario.bin, toolName);
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    "const capturePath = process.env.MATE_E2E_EDITOR_CAPTURE_PATH;",
    "if (!capturePath) process.exit(2);",
    "const payload = { cwd: process.cwd(), argv: process.argv.slice(2) };",
    "fs.writeFileSync(capturePath, JSON.stringify(payload, null, 2));",
    "process.exit(0);",
    "",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);

  return capturePath;
}

async function writeUvStub(scenario: E2EScenario): Promise<string> {
  const capturePath = path.join(scenario.root, "headroom-capture.json");
  const stubPath = path.join(scenario.bin, "uv");
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    'import http from "node:http";',
    'import { spawnSync } from "node:child_process";',
    "const args = process.argv.slice(2);",
    "const sub = args[0];",
    "if (sub === 'init') {",
    "  fs.writeFileSync('pyproject.toml', '[project]\\nname = \"companion\"\\nversion = \"0.1.0\"\\n');",
    "  fs.writeFileSync('uv.lock', '');",
    "  process.exit(0);",
    "}",
    "if (sub === 'add') {",
    "  const setupCapturePath = process.env.MATE_E2E_UV_CAPTURE_PATH;",
    "  if (setupCapturePath) {",
    "    const existing = fs.existsSync(setupCapturePath)",
    "      ? JSON.parse(fs.readFileSync(setupCapturePath, 'utf8'))",
    "      : [];",
    "    existing.push({ cwd: process.cwd(), args });",
    "    fs.writeFileSync(setupCapturePath, JSON.stringify(existing, null, 2));",
    "  }",
    "  if (args[1] === 'headroom-ai[all]') {",
    "    fs.mkdirSync('.headroom', { recursive: true });",
    "    fs.writeFileSync('.headroom/installed.txt', 'headroom\\n');",
    "    fs.writeFileSync('.tokensave', 'headroom\\n');",
    "  }",
    "  process.exit(0);",
    "}",
    "if (sub === 'remove') {",
    "  const setupCapturePath = process.env.MATE_E2E_UV_CAPTURE_PATH;",
    "  if (setupCapturePath) {",
    "    const existing = fs.existsSync(setupCapturePath)",
    "      ? JSON.parse(fs.readFileSync(setupCapturePath, 'utf8'))",
    "      : [];",
    "    existing.push({ cwd: process.cwd(), args });",
    "    fs.writeFileSync(setupCapturePath, JSON.stringify(existing, null, 2));",
    "  }",
    "  if (args[1] === 'headroom-ai') {",
    "    fs.rmSync('.headroom', { recursive: true, force: true });",
    "    fs.rmSync('.tokensave', { force: true });",
    "  }",
    "  process.exit(0);",
    "}",
    "if (sub === 'run') {",
    "  const capturePath = process.env.MATE_E2E_HEADROOM_CAPTURE_PATH;",
    "  if (capturePath) {",
    "    fs.writeFileSync(capturePath, JSON.stringify({ tool: 'uv', cwd: process.cwd(), argv: args }, null, 2));",
    "  }",
    "  const dashIdx = args.indexOf('--');",
    "  if (dashIdx !== -1) {",
    "    const tool = args[dashIdx - 1];",
    "    const toolArgs = args.slice(dashIdx + 1);",
    "    const r = spawnSync(tool, toolArgs, { stdio: 'inherit', env: process.env });",
    "    process.exit(r.status ?? 0);",
    "  }",
    "}",
    "process.exit(0);",
    "",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);

  return capturePath;
}

async function writeHeadroomStub(scenario: E2EScenario): Promise<string> {
  const capturePath = path.join(scenario.root, "headroom-capture.json");
  const stubPath = path.join(scenario.bin, "headroom");
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    'import http from "node:http";',
    'import { spawnSync } from "node:child_process";',
    "const args = process.argv.slice(2);",
    "const capturePath = process.env.MATE_E2E_HEADROOM_CAPTURE_PATH;",
    "const readyPath = process.env.MATE_E2E_HEADROOM_PROXY_READY_FILE;",
    "if (capturePath) {",
    "  fs.writeFileSync(capturePath, JSON.stringify({",
    "    argv: args,",
    "    cwd: process.cwd(),",
    "    env: {",
    "      HEADROOM_MEMORY_DB_PATH: process.env.HEADROOM_MEMORY_DB_PATH ?? null,",
    "      HEADROOM_MEMORY_PROJECT_ROOT: process.env.HEADROOM_MEMORY_PROJECT_ROOT ?? null,",
    "      PATH: process.env.PATH ?? null,",
    "      MATE_ARTIFACT_PATH: process.env.MATE_ARTIFACT_PATH ?? null,",
    "      MATE_REPO_PATH: process.env.MATE_REPO_PATH ?? null,",
    "    },",
    "  }, null, 2));",
    "}",
    "if (args[0] === 'wrap') {",
    "  const dashIdx = args.indexOf('--');",
    "  if (dashIdx !== -1) {",
    "    const tool = args[1];",
    "    const toolArgs = args.slice(dashIdx + 1);",
    "    const r = spawnSync(tool, toolArgs, { stdio: 'inherit', env: process.env });",
    "    process.exit(r.status ?? 0);",
    "  }",
    "}",
    "if (args[0] === 'proxy') {",
    " if (readyPath) {",
    "  fs.writeFileSync(readyPath, 'ready');",
    " }",
    " const portIdx = args.indexOf('--port');",
    " const port = portIdx === -1 ? 8787 : Number(args[portIdx + 1]);",
    " const server = http.createServer((req, res) => {",
    "  if (req.url === '/livez') {",
    "   res.writeHead(200);",
    "   res.end('ok');",
    "   return;",
    "  }",
    "  res.writeHead(404);",
    "  res.end('not found');",
    " });",
    " try {",
    "  server.listen(port, '127.0.0.1');",
    " } catch {}",
    " await new Promise(() => {});",
    "}",
    "process.exit(0);",
    "",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);

  return capturePath;
}

async function writeRtkStub(scenario: E2EScenario): Promise<void> {
  const stubPath = path.join(scenario.bin, "rtk");
  const source = [
    "#!/usr/bin/env bun",
    "const args = process.argv.slice(2);",
    "if (args.includes('init') || args.includes('uninstall')) {",
    "  process.exit(0);",
    "}",
    "process.exit(0);",
    "",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
}

async function writeOpenSpecStub(scenario: E2EScenario): Promise<string> {
  const capturePath = path.join(scenario.root, "openspec-capture.json");
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
    "const capturePath = process.env.MATE_E2E_OPENSPEC_CAPTURE_PATH;",
    "if (capturePath && command !== '--version') {",
    "  const existing = fs.existsSync(capturePath)",
    "    ? JSON.parse(fs.readFileSync(capturePath, 'utf8'))",
    "    : [];",
    "  existing.push({ command, args, cwd: process.cwd() });",
    "  fs.writeFileSync(capturePath, JSON.stringify(existing, null, 2));",
    "}",
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
    "if (command === 'update' || command === 'templates') { process.exit(0); }",
    "process.exit(1);",
    "",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);

  return capturePath;
}

async function writeGraphifyStub(scenario: E2EScenario): Promise<string> {
  const capturePath = path.join(scenario.root, "graphify-capture.json");
  const stubPath = path.join(scenario.bin, "graphify");
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const args = process.argv.slice(2);",
    "",
    "// Handle install command (called by mate companion setup forProvider reconciliation)",
    "if (args[0] === 'install' && args.includes('--project')) {",
    "  const platIdx = args.indexOf('--platform');",
    "  const platform = platIdx >= 0 ? args[platIdx + 1] : 'unknown';",
    "  const cwd = process.cwd();",
    "  const provDir = `.${platform}`;",
    "  fs.mkdirSync(path.join(cwd, provDir, 'skills', 'graphify'), { recursive: true });",
    "  const skill = '# graphify\\n\\ngraphify-out/graph.json\\ngraphify-out/GRAPH_REPORT.md\\n';",
    "  fs.writeFileSync(path.join(cwd, provDir, 'skills', 'graphify', 'SKILL.md'), skill, 'utf8');",
    "  const agentFiles = { claude: 'CLAUDE.md', opencode: 'AGENTS.md' };",
    "  const agentFile = agentFiles[platform] || 'AGENTS.md';",
    "  const agentPath = path.join(cwd, provDir, agentFile);",
    "  const prev = (() => { try { return fs.readFileSync(agentPath, 'utf8'); } catch { return ''; } })();",
    "  if (!prev.includes('## graphify')) {",
    "    const section = '\\n## graphify\\n\\ngraphify-out/graph.json\\ngraphify-out/GRAPH_REPORT.md\\n';",
    "    fs.writeFileSync(agentPath, prev.trimEnd() + section, 'utf8');",
    "  }",
    "  process.exit(0);",
    "}",
    "",
    "// All other commands: capture call args to capture file",
    "const capturePath = process.env.MATE_E2E_GRAPHIFY_CAPTURE_PATH;",
    "if (!capturePath) process.exit(2);",
    "const payload = {",
    "  cwd: process.cwd(),",
    "  argv: args,",
    "  env: {",
    "    MATE_ARTIFACT_PATH: process.env.MATE_ARTIFACT_PATH ?? null,",
    "    MATE_REPO_ID: process.env.MATE_REPO_ID ?? null,",
    "    MATE_REPO_PATH: process.env.MATE_REPO_PATH ?? null,",
    "  },",
    "};",
    "fs.writeFileSync(capturePath, JSON.stringify(payload, null, 2));",
    "",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
  return capturePath;
}

// A graphify stub for `cap sync`, which invokes graphify once with --update. Unlike
// writeGraphifyStub (single overwriting capture), this appends each subcommand to a
// log file so the sync path is observable. Set MATE_E2E_GRAPHIFY_FAIL_UPDATE to make
// `--update` exit non-zero.
async function writeGraphifySyncStub(scenario: E2EScenario): Promise<string> {
  const logPath = path.join(scenario.root, "graphify-sync-log.txt");
  const stubPath = path.join(scenario.bin, "graphify");
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const args = process.argv.slice(2);",
    "",
    "// Handle install command (called by mate companion setup forProvider reconciliation)",
    "if (args[0] === 'install' && args.includes('--project')) {",
    "  const platIdx = args.indexOf('--platform');",
    "  const platform = platIdx >= 0 ? args[platIdx + 1] : 'unknown';",
    "  const cwd = process.cwd();",
    "  const provDir = `.${platform}`;",
    "  fs.mkdirSync(path.join(cwd, provDir, 'skills', 'graphify'), { recursive: true });",
    "  const skill = '# graphify\\n\\ngraphify-out/graph.json\\n';",
    "  fs.writeFileSync(path.join(cwd, provDir, 'skills', 'graphify', 'SKILL.md'), skill, 'utf8');",
    "  process.exit(0);",
    "}",
    "",
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: args, graphifyOut: process.env.GRAPHIFY_OUT ?? null }) + "\\n");`,
    "if (args.includes('--update') && process.env.MATE_E2E_GRAPHIFY_FAIL_UPDATE) process.exit(1);",
    "process.exit(0);",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
  return logPath;
}

// A tokensave stub for `cap sync`. `sync` writes a real (non-empty) sqlite db so the
// test exercises the steady-state sync path and the capture reflects that invocation.
async function writeTokensaveSyncStub(scenario: E2EScenario): Promise<string> {
  const capturePath = path.join(scenario.root, "tokensave-sync-capture.json");
  const stubPath = path.join(scenario.bin, "tokensave");
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { Database } from "bun:sqlite";',
    "const args = process.argv.slice(2);",
    "const cmd = args[0];",
    "if (cmd === 'init') {",
    "  fs.mkdirSync('.tokensave', { recursive: true });",
    "  fs.writeFileSync(path.join('.tokensave', 'state.txt'), 'init\\n');",
    "}",
    "if (cmd === 'sync') {",
    "  fs.mkdirSync('.tokensave', { recursive: true });",
    "  const db = new Database(path.join('.tokensave', 'tokensave.db'));",
    "  db.run('CREATE TABLE IF NOT EXISTS files (id INTEGER)');",
    "  db.run('INSERT INTO files (id) VALUES (1)');",
    "  db.close();",
    "}",
    "const capturePath = process.env.MATE_E2E_TOKENSAVE_CAPTURE_PATH;",
    "if (capturePath) fs.writeFileSync(capturePath, JSON.stringify({ argv: args }, null, 2));",
    "process.exit(0);",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
  return capturePath;
}

async function writeTokensaveInstallStub(scenario: E2EScenario): Promise<void> {
  const stubPath = path.join(scenario.bin, "tokensave");
  const source = [
    "#!/usr/bin/env bun",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') process.exit(0);",
    "process.exit(0);",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

// injectEditorFolder spawns the editor CLI detached and unref'd so `mate`
// doesn't block on it; the stub may still be starting up when the parent
// process exits, so poll briefly instead of reading the capture file once.
async function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (
      await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false)
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("mate CLI e2e", () => {
  test("confirmed setup initializes only inside the temp companion and temp HOME", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-confirm-");

    const result = await setupCompanion(scenario);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Initialize this directory as a Mate companion repository?");
    await fs.access(path.join(scenario.companion, ".mate", "config", "framework.yaml"));
    await fs.access(path.join(scenario.home, ".mate", "config.yaml"));
    await expect(fs.access(path.join(scenario.working, ".mate"))).rejects.toThrow();
  });

  test("flagged setup persists only the selected providers and capabilities", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-selection-");

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["claude", "opencode"],
      capabilities: ["openspec", "headroom"],
    });

    expect(result.exitCode).toBe(0);

    const config = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("- claude");
    expect(config).toContain("- opencode");
    expect(config).toContain("name: openspec");
    expect(config).toContain("name: headroom");
    expect(config).not.toContain("react-doctor");
  });

  test("flagged setup persists selected package managers", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-package-managers-");
    await writeUvStub(scenario);

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["claude"],
      packageManagers: ["bun", "uv"],
      capabilities: ["openspec"],
    });

    expect(result.exitCode).toBe(0);

    const config = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("packageManagers:");
    expect(config).toContain("- bun");
    expect(config).toContain("- uv");
  });

  test("flagged setup persists openspec schema profile and seeds companion-local schema state", async () => {
    const scenario = await createScenario("mate-cli-e2e-openspec-schema-");

    const result = await setupCompanion(scenario, ["--openspec-schema", "mate-v1"], {
      allowedAgents: ["claude"],
      capabilities: ["openspec"],
    });

    expect(result.exitCode).toBe(0);

    const config = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("name: openspec");
    expect(config).toContain("schemaProfile: mate-v1");
    await expect(
      fs.readFile(path.join(scenario.companion, "openspec", "config.yaml"), "utf8"),
    ).resolves.toBe("schema: mate-v1\n");
    await fs.access(path.join(scenario.companion, "openspec", "schemas", "mate-v1", "schema.yaml"));
  });

  test("setup writes headroom capability without memory to config when headroom binary is present", async () => {
    const scenario = await createScenario("mate-cli-e2e-headroom-setup-");
    await writeHeadroomStub(scenario);

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["headroom"],
        })
      ).exitCode,
    ).toBe(0);

    const config = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("name: headroom");
    expect(config).not.toContain("memory: true");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["react-doctor"],
        })
      ).exitCode,
    ).toBe(0);

    const updatedConfig = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(updatedConfig).not.toContain("name: headroom");
  });

  test("setup deploys the OpenCode companion plugin into the companion runtime", async () => {
    const scenario = await createScenario("mate-cli-e2e-opencode-setup-plugin-");

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["opencode"],
      capabilities: ["openspec"],
    });

    expect(result.exitCode).toBe(0);
    await fs.access(path.join(scenario.companion, ".opencode", "opencode.json"));
    await fs.access(path.join(scenario.companion, ".opencode", "plugins", "mate-add-dir.ts"));
    await fs.access(path.join(scenario.companion, ".opencode", "plugins", "mate-companion.ts"));
  });

  test("rerun setup removes deselected compatibility artifacts", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-deselect-");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude", "opencode"],
          capabilities: ["openspec", "react-doctor"],
        })
      ).exitCode,
    ).toBe(0);

    await fs.access(path.join(scenario.companion, ".claude", "skills", "openspec-explore"));

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["react-doctor"],
        })
      ).exitCode,
    ).toBe(0);

    await expect(
      fs.access(path.join(scenario.companion, ".claude", "skills", "openspec-explore")),
    ).rejects.toThrow();
  });

  test("setup reconciles openspec skills as allowed agents are added and removed", async () => {
    const scenario = await createScenario("mate-cli-e2e-openspec-reconcile-");
    const capturePath = await writeOpenSpecStub(scenario);

    expect(
      (
        await setupCompanion(
          scenario,
          [],
          { allowedAgents: ["opencode"], capabilities: ["openspec"] },
          { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
        )
      ).exitCode,
    ).toBe(0);

    await fs.access(
      path.join(scenario.companion, ".opencode", "skills", "openspec-explore", "SKILL.md"),
    );
    await expect(
      fs.access(path.join(scenario.companion, ".claude", "skills", "openspec-explore")),
    ).rejects.toThrow();

    expect(
      (
        await setupCompanion(
          scenario,
          [],
          { allowedAgents: ["claude", "opencode"], capabilities: ["openspec"] },
          { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
        )
      ).exitCode,
    ).toBe(0);

    await fs.access(
      path.join(scenario.companion, ".claude", "skills", "openspec-explore", "SKILL.md"),
    );
    await fs.access(
      path.join(scenario.companion, ".opencode", "skills", "openspec-explore", "SKILL.md"),
    );

    expect(
      (
        await setupCompanion(
          scenario,
          [],
          { allowedAgents: ["opencode"], capabilities: ["openspec"] },
          { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
        )
      ).exitCode,
    ).toBe(0);

    await expect(
      fs.access(path.join(scenario.companion, ".opencode", "skills", "openspec-explore")),
    ).resolves.toBeNull();

    const invocations = await readJson<Array<{ command: string; args: string[] }>>(capturePath);
    expect(invocations.map((entry) => entry.command)).toEqual([
      "init",
      "update",
      "init",
      "update",
      "init",
      "update",
    ]);
    expect(invocations[0]?.args).toContain("opencode");
    expect(invocations[2]?.args).toContain("claude,opencode");
    expect(invocations[4]?.args).toContain("opencode");
  });

  test("declined setup leaves no companion config or provider files behind", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-decline-");

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["companion", "setup"],
      input: "n\n",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Aborted.");
    await expect(fs.access(path.join(scenario.companion, ".mate"))).rejects.toThrow();
    await expect(fs.access(path.join(scenario.companion, ".claude"))).rejects.toThrow();
    await expect(fs.access(path.join(scenario.companion, "AGENTS.md"))).rejects.toThrow();
    await expect(fs.access(path.join(scenario.home, ".mate", "config.yaml"))).rejects.toThrow();
  });

  test("linking and doctor succeed in one isolated flow", async () => {
    const scenario = await createScenario("mate-cli-e2e-repo-flow-");

    await writeHeadroomStub(scenario);
    expect((await setupCompanion(scenario, ["--capability", "headroom"])).exitCode).toBe(0);

    const linkResult = await linkRepository(scenario);
    expect(linkResult.exitCode).toBe(0);
    expect(linkResult.stdout).toContain("Successfully linked companion for app");

    const doctorResult = await runMate(scenario, {
      cwd: scenario.working,
      args: ["doctor"],
    });
    expect(doctorResult.exitCode).toBe(0);
    expect(doctorResult.stdout).toContain("linked-working-repository");
    expect(doctorResult.stdout).toContain(scenario.companion);
    expect(doctorResult.stdout).toContain("app");
    expect(doctorResult.stdout).toContain("headroom");
  });

  test("companion list returns all linked repositories", async () => {
    const scenario = await createScenario("mate-cli-e2e-repo-list-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "list"],
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      repositories: Array<{ id: string; path: string }>;
    };
    expect(parsed.repositories).toHaveLength(1);
    expect(parsed.repositories[0].id).toBe("app");
    expect(parsed.repositories[0].path).toBe(scenario.working);
  });

  test("doctor reports companion-repository state when no repos are linked", async () => {
    const scenario = await createScenario("mate-cli-e2e-doctor-no-repo-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["doctor"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("companion-repository");
    expect(result.stdout).toContain("none");
    expect(result.stdout).toContain("openspec");
  });

  test("cap openspec runs openspec from the companion root", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-openspec-");
    const capturePath = await writeOpenSpecStub(scenario);

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "openspec", "update", "--force"],
      env: { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocations = await readJson<Array<{ cwd: string; args: string[] }>>(capturePath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.cwd).toBe(scenario.companion);
    expect(invocations[0]?.args).toEqual(["update", "--force"]);
  });

  test("cap openspec injects companion schema for templates when absent", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-openspec-templates-");
    const capturePath = await writeOpenSpecStub(scenario);

    expect((await setupCompanion(scenario, [], { openspecSchema: "mate-v1" })).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "openspec", "templates", "--json"],
      env: { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocations = await readJson<Array<{ cwd: string; args: string[] }>>(capturePath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.cwd).toBe(scenario.companion);
    expect(invocations[0]?.args).toEqual(["templates", "--schema", "mate-v1", "--json"]);
  });

  test("cap openspec preserves explicit schema for templates", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-openspec-templates-explicit-");
    const capturePath = await writeOpenSpecStub(scenario);

    expect((await setupCompanion(scenario, [], { openspecSchema: "mate-v1" })).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "openspec", "templates", "--schema", "spec-driven", "--json"],
      env: { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocations = await readJson<Array<{ cwd: string; args: string[] }>>(capturePath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toEqual(["templates", "--schema", "spec-driven", "--json"]);
  });

  test("top-level openspec command is rejected", async () => {
    const scenario = await createScenario("mate-cli-e2e-openspec-alias-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["openspec", "update"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: openspec");
  });

  test("cap graphify build routes through extract with companion-managed output", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-graphify-build-");
    const capturePath = await writeGraphifyStub(scenario);

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["graphify"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "graphify", "build", "--mode", "deep"],
      env: { MATE_E2E_GRAPHIFY_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocation = await readJson<{
      cwd: string;
      argv: string[];
      env: Record<string, string | null>;
    }>(capturePath);
    expect(invocation.cwd).toBe(scenario.working);
    expect(invocation.argv[0]).toBe("extract");
    expect(invocation.argv[1]).toBe(scenario.working);
    expect(invocation.argv).toContain("--out");
    expect(invocation.argv).toContain(path.join(scenario.companion, ".graphify", "app"));
    expect(invocation.argv.slice(-2)).toEqual(["--mode", "deep"]);
  });

  test("cap graphify query appends the shared graph path when no graph is provided", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-graphify-query-");
    const capturePath = await writeGraphifyStub(scenario);

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["graphify"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "graphify", "query", "symbol:Mate"],
      env: { MATE_E2E_GRAPHIFY_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocation = await readJson<{ argv: string[] }>(capturePath);
    expect(invocation.argv).toEqual([
      "query",
      "symbol:Mate",
      "--graph",
      path.join(scenario.companion, ".graphify", "app", "graphify-out", "graph.json"),
    ]);
  });

  test("cap graphify passes through path-first --update form", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-graphify-update-");
    const capturePath = await writeGraphifyStub(scenario);

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["graphify"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "graphify", scenario.working, "--update", "--force"],
      env: { MATE_E2E_GRAPHIFY_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocation = await readJson<{ argv: string[] }>(capturePath);
    expect(invocation.argv).toEqual([scenario.working, "--update", "--force"]);
  });

  test("cap rejects direct tokensave passthrough in favor of the native tokensave cli", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-tokensave-disabled-");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["tokensave"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "tokensave", "status"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mate: unknown capability command: tokensave");
  });

  test("cap sync runs tokensave and graphify by default", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-sync-");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["graphify", "tokensave"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    // setupCompanion rewrites the capability stubs, so install the sync-aware stubs
    // afterwards to overwrite them.
    const graphifyLog = await writeGraphifySyncStub(scenario);
    const tokensaveCapture = await writeTokensaveSyncStub(scenario);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "sync"],
      env: { MATE_E2E_TOKENSAVE_CAPTURE_PATH: tokensaveCapture },
    });

    expect(result.exitCode).toBe(0);
    const log = (await fs.readFile(graphifyLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; graphifyOut: string | null });
    expect(log).toEqual([
      {
        argv: [".", "--update", "--code-only"],
        graphifyOut: path.join(scenario.companion, ".graphify", "app", "graphify-out"),
      },
    ]);
    const invocation = await readJson<{ argv: string[] }>(tokensaveCapture);
    expect(invocation.argv).toEqual(["sync"]);
  });

  test("cap sync --graphify runs only graphify sync", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-sync-graphify-");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["graphify", "tokensave"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const graphifyLog = await writeGraphifySyncStub(scenario);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "sync", "--graphify"],
    });

    expect(result.exitCode).toBe(0);
    const log = (await fs.readFile(graphifyLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; graphifyOut: string | null });
    expect(log).toEqual([
      {
        argv: [".", "--update", "--code-only"],
        graphifyOut: path.join(scenario.companion, ".graphify", "app", "graphify-out"),
      },
    ]);
    expect(await fs.exists(path.join(scenario.root, "tokensave-sync-capture.json"))).toBe(false);
  });

  test("cap sync --graphify fails without running tokensave", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-sync-fail-");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["graphify", "tokensave"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const graphifyLog = await writeGraphifySyncStub(scenario);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "sync", "--graphify"],
      env: {
        MATE_E2E_GRAPHIFY_FAIL_UPDATE: "1",
      },
    });

    expect(result.exitCode).toBe(1);
    const log = (await fs.readFile(graphifyLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; graphifyOut: string | null });
    expect(log).toEqual([
      {
        argv: [".", "--update", "--code-only"],
        graphifyOut: path.join(scenario.companion, ".graphify", "app", "graphify-out"),
      },
    ]);
    expect(await fs.exists(path.join(scenario.root, "tokensave-sync-capture.json"))).toBe(false);
  });

  test("launch installs tokensave MCP wiring for claude in companion settings", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-tokensave-claude-");
    const capturePath = await writeAdapterStub(scenario, "claude");
    initWorkingRepoGit(scenario);

    const setup = await setupCompanion(scenario, [], {
      allowedAgents: ["claude"],
      capabilities: ["tokensave"],
    });
    expect(setup.exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["claude", "--print", "hello"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(
      await fs.readFile(path.join(scenario.companion, ".claude", "settings.local.json"), "utf8"),
    );
    // MCP server lives in the companion .mcp.json (loaded via --mcp-config),
    // not inline in settings.local.json, though the mcp permission entry is
    // still pre-seeded.
    expect(settings.mcpServers?.tokensave).toBeUndefined();
    expect(settings.permissions?.allow ?? []).toContain("mcp__tokensave__*");
    const mcpConfig = JSON.parse(
      await fs.readFile(path.join(scenario.companion, ".mcp.json"), "utf8"),
    );
    expect(mcpConfig.mcpServers?.tokensave).toEqual({
      command: path.join(scenario.bin, "tokensave"),
      args: ["serve"],
    });
    const workingRepoSettings = JSON.parse(
      await fs.readFile(path.join(scenario.working, ".claude", "settings.local.json"), "utf8"),
    );
    expect(workingRepoSettings).toEqual({
      permissions: { additionalDirectories: [scenario.companion] },
    });
    // The working repo receives no Mate-managed Claude MCP declaration.
    await expect(fs.access(path.join(scenario.working, ".mcp.json"))).rejects.toThrow();
  });

  test("setup installs graphify companion assets for opencode provider", async () => {
    const scenario = await createScenario("mate-cli-e2e-graphify-opencode-install-");
    await writeGraphifyStub(scenario);

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["opencode"],
      capabilities: ["graphify"],
    });

    expect(result.exitCode).toBe(0);
    // Graphify skill file installed into companion .opencode directory
    const skillStat = await fs.stat(
      path.join(scenario.companion, ".opencode", "skills", "graphify", "SKILL.md"),
    );
    expect(skillStat.isFile()).toBe(true);
  });

  test("setup does not write graphify guidance to AGENTS.md for opencode", async () => {
    const scenario = await createScenario("mate-cli-e2e-graphify-opencode-assets-");
    await writeGraphifyStub(scenario);

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["opencode"],
      capabilities: ["graphify"],
    });

    expect(result.exitCode).toBe(0);
    // Graphify skill should exist in companion
    const skillPath = path.join(scenario.companion, ".opencode", "skills", "graphify", "SKILL.md");
    const stat = await fs.stat(skillPath);
    expect(stat.isFile()).toBe(true);

    // Graphify wrappers are package-owned and are not copied into companions.
    await expect(
      fs.access(path.join(scenario.companion, ".mate", "bin", "graphify")),
    ).rejects.toThrow();

    const agentsPath = path.join(scenario.companion, "AGENTS.md");
    await expect(fs.access(agentsPath)).rejects.toThrow();
  });

  test("setup composes graphify guidance into OpenCode companion plugin when enabled", async () => {
    const enabledScenario = await createScenario("mate-cli-e2e-graphify-opencode-guidance-on-");
    await writeGraphifyStub(enabledScenario);

    let result = await setupCompanion(enabledScenario, [], {
      allowedAgents: ["opencode"],
      capabilities: ["graphify"],
    });

    expect(result.exitCode).toBe(0);

    const guidancePath = path.join(enabledScenario.companion, ".opencode", ".mate-guidance.json");
    const guidance = JSON.parse(await fs.readFile(guidancePath, "utf8"));
    expect(guidance.codebaseExplorationGuidance).toContain(
      '<codebase-exploration-rules priority="mandatory">',
    );
    expect(guidance.codebaseExplorationGuidance).toContain(
      "$MATE_ARTIFACT_PATH/.graphify/$MATE_REPO_ID/graphify-out/",
    );
    expect(guidance.errors).toEqual([]);
  });

  test("cap rejects unknown capability names", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-unknown-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await installCompanion(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["cap", "unknown"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown capability command");
  });

  test("top-level setup is rejected", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-top-level-rejected-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await installCompanion(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["setup"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: setup");
  });

  test("companion setup delegates to the linked companion repository", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-guard-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "setup"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("inside linked working repo `app`");

    const framework = parse(
      await fs.readFile(path.join(scenario.working, ".mate", "config", "framework.yaml"), "utf8"),
    ) as { type?: string };
    expect(framework.type).toBe("working");
  });

  test("claude fails when run from companion directory with no linked working repository", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-no-repo-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await installCompanion(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["claude", "--"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "mate: launch must be run from a working repository directory.",
    );
    expect(result.stderr).toContain("mate companion link");
  });

  test("companion open launches code with the active repo and companion", async () => {
    const scenario = await createScenario("mate-cli-e2e-workspace-open-");
    const capturePath = await writeEditorStub(scenario, "code");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "open"],
      env: { MATE_E2E_EDITOR_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);

    await waitForFile(capturePath);
    const invocation = await readJson<{ cwd: string; argv: string[] }>(capturePath);
    expect(invocation.cwd).toBe(scenario.working);
    expect(invocation.argv).toEqual(["--add", scenario.working, scenario.companion]);
    expect(
      await readJson<{ folders: Array<{ path: string }> }>(
        path.join(scenario.working, ".mate", "workspace.code-workspace"),
      ),
    ).toEqual({ folders: [{ path: scenario.working }, { path: scenario.companion }] });
  });

  test("opencode rejects disallowed tools before any adapter binary is spawned", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-disallowed-");
    const capturePath = await writeAdapterStub(scenario, "opencode");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["opencode", "--"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("disallowed by active repository policy.");
    await expect(fs.access(capturePath)).rejects.toThrow();
  });

  for (const testCase of [
    {
      tool: "claude" as const,
      allowedAgents: undefined,
      setupSelections: undefined,
      launchArgs: ["claude", "--print", "hello"],
      assertInvocation(
        invocation: {
          cwd: string;
          argv: string[];
          env: Record<string, string | null>;
        },
        scenario: E2EScenario,
      ) {
        expect(invocation.argv[0]).toBe("--add-dir");
        expect(invocation.argv[1]).toBe(scenario.companion);
        expect(invocation.argv).toContain("--append-system-prompt");
        expect(invocation.argv).toContain("--print");
        expect(invocation.argv).toContain("hello");
      },
    },
    {
      tool: "opencode" as const,
      allowedAgents: ["opencode"],
      setupSelections: { allowedAgents: ["opencode"], capabilities: ["openspec"] },
      launchArgs: ["opencode", "--mode", "chat"],
      assertInvocation(
        invocation: {
          cwd: string;
          argv: string[];
          env: Record<string, string | null>;
        },
        scenario: E2EScenario,
      ) {
        expect(invocation.argv[0]).toBe(scenario.working);
        expect(invocation.argv).toContain("--mode");
        expect(invocation.argv).toContain("chat");
        expect(invocation.env.OPENCODE_CONFIG_DIR).toBe(path.join(scenario.companion, ".opencode"));
      },
    },
  ]) {
    test(`launch smoke test captures adapter context for ${testCase.tool}`, async () => {
      const scenario = await createScenario(`mate-cli-e2e-launch-${testCase.tool}-`);
      const capturePath = await writeAdapterStub(scenario, testCase.tool);
      initWorkingRepoGit(scenario);

      expect((await setupCompanion(scenario, [], testCase.setupSelections)).exitCode).toBe(0);
      expect((await linkRepository(scenario)).exitCode).toBe(0);

      const result = await runMate(scenario, {
        cwd: scenario.working,
        args: testCase.launchArgs,
        input: "y\n",
        env: { MATE_E2E_CAPTURE_PATH: capturePath },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Continue? [y/N]");

      const launchResult = JSON.parse(result.stdout) as { exitCode: number };
      expect(launchResult.exitCode).toBe(0);

      const invocation = await readJson<{
        cwd: string;
        argv: string[];
        env: Record<string, string | null>;
      }>(capturePath);

      expect(invocation.cwd).toBe(scenario.working);
      expect(invocation.env.MATE_ARTIFACT_PATH).toBe(scenario.companion);
      expect(invocation.env.MATE_REPO_ID).toBe("app");
      expect(invocation.env.MATE_REPO_PATH).toBe(scenario.working);
      expect(invocation.env.MATE_REPO_PROFILE).toBe("default");
      expect(JSON.parse(invocation.env.MATE_POLICY_JSON ?? "{}")).toEqual({
        allowedAgents: testCase.allowedAgents ?? ["claude"],
      });

      testCase.assertInvocation(invocation, scenario);
      const exclude = await fs.readFile(
        path.join(scenario.working, ".git", "info", "exclude"),
        "utf8",
      );
      expect(exclude).toContain(".claude/settings.local.json");
    });
  }

  test("launch pre-seeds companion Claude hooks and permissions, git-excluded and un-duplicated", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-claude-settings-");
    const capturePath = await writeAdapterStub(scenario, "claude");
    initWorkingRepoGit(scenario);

    const setupSelections = {
      allowedAgents: ["claude"],
      capabilities: ["openspec", "react-doctor"],
    };
    expect((await setupCompanion(scenario, [], setupSelections)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const launch = async () =>
      runMate(scenario, {
        cwd: scenario.working,
        args: ["claude", "--print", "hello"],
        input: "y\n",
        env: { MATE_E2E_CAPTURE_PATH: capturePath },
      });

    interface HookGroup {
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }
    interface ClaudeSettings {
      hooks?: Record<string, HookGroup[]>;
      permissions?: { allow?: string[] };
    }
    // Mate-managed Claude config now lives in companion settings, loaded at launch
    // via `--settings`, instead of the working repo.
    const settingsPath = path.join(scenario.companion, ".claude", "settings.local.json");

    expect((await launch()).exitCode).toBe(0);
    const first = JSON.parse(await fs.readFile(settingsPath, "utf8")) as ClaudeSettings;

    const hasCommand = (groups: HookGroup[] | undefined, needle: string): boolean =>
      (groups ?? []).some((group) =>
        (group.hooks ?? []).some((hook) => (hook.command ?? "").includes(needle)),
      );
    expect(hasCommand(first.hooks?.PreToolUse, "validate-artifact-path")).toBe(true);
    expect(hasCommand(first.hooks?.SessionStart, "mate-session-banner")).toBe(true);
    expect(hasCommand(first.hooks?.PostToolBatch, "react-doctor.sh")).toBe(true);
    expect(first.permissions?.allow).toContain("Bash(openspec:*)");
    expect(first.permissions?.allow).toContain("Bash(npx react-doctor:*)");

    const workingRepoSettings = JSON.parse(
      await fs.readFile(path.join(scenario.working, ".claude", "settings.local.json"), "utf8"),
    );
    expect(workingRepoSettings).toEqual({
      permissions: { additionalDirectories: [scenario.companion] },
    });

    const exclude = await fs.readFile(
      path.join(scenario.working, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude).toContain(".claude/settings.local.json");

    // A second launch must converge on the same content — no duplicated hooks or
    // allow entries.
    expect((await launch()).exitCode).toBe(0);
    const second = await fs.readFile(settingsPath, "utf8");
    expect(second).toBe(JSON.stringify(first, null, 2) + "\n");
  });

  for (const testCase of [
    {
      tool: "claude" as const,
      allowedAgents: undefined,
      setupSelections: {
        allowedAgents: ["claude"],
        capabilities: ["openspec", "react-doctor", "headroom"],
      },
      launchArgs: ["claude", "--print", "hello"],
    },
    {
      tool: "opencode" as const,
      allowedAgents: ["opencode"],
      setupSelections: { allowedAgents: ["opencode"], capabilities: ["openspec", "headroom"] },
      launchArgs: ["opencode", "--mode", "chat"],
    },
  ]) {
    test(
      `launch uses headroom proxy for ${testCase.tool} when configured and installed`,
      async () => {
        const scenario = await createScenario(`mate-cli-e2e-headroom-wrap-${testCase.tool}-`);
        await writeHeadroomStub(scenario);
        const capturePath = await writeAdapterStub(scenario, testCase.tool);
        const readyPath = path.join(scenario.root, "headroom-ready");

        expect((await setupCompanion(scenario, [], testCase.setupSelections)).exitCode).toBe(0);
        expect((await linkRepository(scenario)).exitCode).toBe(0);

        const result = await runMate(scenario, {
          cwd: scenario.working,
          args: testCase.launchArgs,
          input: "y\n",
          env: {
            MATE_E2E_CAPTURE_PATH: capturePath,
            MATE_E2E_HEADROOM_PROXY_READY_FILE: readyPath,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toContain("`headroom` was not found on PATH");

        const invocation = await readJson<{
          cwd: string;
          argv: string[];
          env: {
            ANTHROPIC_BASE_URL: string | null;
            OPENAI_BASE_URL: string | null;
            OPENCODE_CONFIG_CONTENT: string | null;
            PATH: string | null;
            MATE_ARTIFACT_PATH: string | null;
            MATE_REPO_PATH: string | null;
          };
        }>(capturePath);

        expect(invocation.cwd).toBe(scenario.working);
        // Agent is launched directly — not wrapped via headroom
        expect(invocation.argv).not.toContain("wrap");
        expect(invocation.env.MATE_ARTIFACT_PATH).toBe(scenario.companion);
        expect(invocation.env.MATE_REPO_PATH).toBe(scenario.working);
        // Memory DB path is passed as CLI flags to proxy, not injected into agent env
        expect(invocation.env).not.toHaveProperty("HEADROOM_MEMORY_DB_PATH");
        expect(invocation.env).not.toHaveProperty("HEADROOM_MEMORY_PROJECT_ROOT");
      },
      // setup + link + launch + proxy startup; 10s was too tight under parallel
      // load. 30s also lets the runMate watchdog fire first and dump output.
      { timeout: 30000 },
    );

    test(`launch is blocked when required headroom dependencies are missing for ${testCase.tool}`, async () => {
      const scenario = await createScenario(`mate-cli-e2e-headroom-fallback-${testCase.tool}-`);
      const capturePath = await writeAdapterStub(scenario, testCase.tool);

      // Write headroom stub so setup doesn't prompt for install
      await writeHeadroomStub(scenario);
      expect((await setupCompanion(scenario, [], testCase.setupSelections)).exitCode).toBe(0);
      expect((await linkRepository(scenario)).exitCode).toBe(0);

      // Remove headroom binary and strip it from PATH to simulate it being absent at launch time
      await fs.rm(path.join(scenario.bin, "headroom"));
      const pathWithoutHeadroom = pathWithoutCommand("headroom", process.env.PATH ?? "");

      const result = await runMate(scenario, {
        cwd: scenario.working,
        args: testCase.launchArgs,
        input: "y\n",
        env: {
          MATE_E2E_CAPTURE_PATH: capturePath,
          PATH: `${scenario.bin}:${pathWithoutHeadroom}`,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/Missing required dependency|Mate has not been installed/);
      expect(result.stderr).toContain("Headroom CLI");
      await expect(fs.access(capturePath)).rejects.toThrow();
    }, 30000);
  }

  test("launch repairs missing OpenCode companion runtime assets before spawn", async () => {
    const scenario = await createScenario("mate-cli-e2e-opencode-repair-");
    const capturePath = await writeAdapterStub(scenario, "opencode");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["opencode"],
          capabilities: ["openspec"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const pluginPath = path.join(scenario.companion, ".opencode", "plugins", "mate-companion.ts");
    const addDirPluginPath = path.join(
      scenario.companion,
      ".opencode",
      "plugins",
      "mate-add-dir.ts",
    );
    const configPath = path.join(scenario.companion, ".opencode", "opencode.json");
    await fs.rm(pluginPath);
    await fs.rm(addDirPluginPath);
    await fs.rm(configPath);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["opencode", "--mode", "chat"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    await fs.access(pluginPath);
    await fs.access(addDirPluginPath);
    await fs.access(configPath);
    await fs.access(capturePath);
  }, 30000);

  test("synchronizes Git-backed companions and consumes both agent bypass commands", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-git-sync-");
    const claudeCapturePath = await writeAdapterStub(scenario, "claude");
    const opencodeCapturePath = await writeAdapterStub(scenario, "opencode");
    expect(
      (
        await setupCompanion(scenario, ["--git-mode", "auto"], {
          allowedAgents: ["claude", "opencode"],
          capabilities: ["openspec"],
        })
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runMate(scenario, {
          cwd: scenario.companion,
          args: ["install", "--yes"],
        })
      ).exitCode,
    ).toBe(0);
    const remote = await initCompanionGit(scenario);
    const upstream = path.join(scenario.root, "companion-upstream");
    runGit(scenario.root, ["clone", "-q", remote, upstream]);
    runGit(upstream, ["config", "user.email", "mate-e2e@example.com"]);
    runGit(upstream, ["config", "user.name", "Mate E2E"]);
    await fs.writeFile(path.join(upstream, ".mate", "origin-marker"), "from origin\n");
    runGit(upstream, ["add", ".mate/origin-marker"]);
    runGit(upstream, ["commit", "-qm", "origin marker"]);
    runGit(upstream, ["push", "-q"]);

    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const syncResult = await runMate(scenario, {
      cwd: scenario.working,
      args: ["claude", "--print", "hello"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: claudeCapturePath },
    });
    expect(syncResult.exitCode).toBe(0);
    expect(await fs.readFile(path.join(scenario.companion, ".mate", "origin-marker"), "utf8")).toBe(
      "from origin\n",
    );
    const syncedInvocation = await readJson<{ argv: string[] }>(claudeCapturePath);
    expect(syncedInvocation.argv).toContain("--print");
    expect(syncedInvocation.argv).not.toContain("--no-git");

    const repeatSyncResult = await runMate(scenario, {
      cwd: scenario.working,
      args: ["claude", "--print", "again"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: claudeCapturePath },
    });
    expect(repeatSyncResult.exitCode).toBe(0);

    runGit(scenario.companion, [
      "remote",
      "set-url",
      "origin",
      path.join(scenario.root, "offline.git"),
    ]);
    const bypassResult = await runMate(scenario, {
      cwd: scenario.working,
      args: ["opencode", "--", "--no-git", "--mode", "chat"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: opencodeCapturePath },
    });
    expect(bypassResult.exitCode).toBe(0);
    const bypassInvocation = await readJson<{ argv: string[] }>(opencodeCapturePath);
    expect(bypassInvocation.argv).toContain("--mode");
    expect(bypassInvocation.argv).toContain("chat");
    expect(bypassInvocation.argv).not.toContain("--no-git");
  }, 30000);

  test("launch fails early when the OpenCode companion runtime remains incomplete", async () => {
    const scenario = await createScenario("mate-cli-e2e-opencode-preflight-");
    const capturePath = await writeAdapterStub(scenario, "opencode");
    const providersRoot = await createSetupProvidersRoot(scenario, {
      includeOpenCodePlugin: false,
    });

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["opencode"],
          capabilities: ["openspec"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    await fs.rm(path.join(scenario.companion, ".opencode", "plugins", "mate-companion.ts"));

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["opencode", "--mode", "chat"],
      input: "y\n",
      env: {
        MATE_E2E_CAPTURE_PATH: capturePath,
        MATE_SETUP_PROVIDERS_ROOT: providersRoot,
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OpenCode companion runtime is incomplete");
    expect(result.stderr).toContain("re-running `mate companion setup`");
    await expect(fs.access(capturePath)).rejects.toThrow();
  });

  test(
    "interactive launch skips the redundant review confirmation",
    { timeout: 30_000 },
    async () => {
      const scenario = await createScenario("mate-cli-e2e-launch-direct-");
      const capturePath = await writeAdapterStub(scenario, "claude");

      initWorkingRepoGit(scenario);
      expect(
        (
          await setupCompanion(scenario, [], {
            allowedAgents: ["claude"],
            capabilities: ["openspec", "headroom"],
          })
        ).exitCode,
      ).toBe(0);
      expect((await linkRepository(scenario)).exitCode).toBe(0);

      const result = await runMateInTty(scenario, {
        cwd: scenario.working,
        args: ["claude"],
        inputChunks: [],
        env: { MATE_E2E_CAPTURE_PATH: capturePath },
        timeoutSeconds: 15,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Review launch");
      expect(result.stdout).not.toContain("Headroom:");
      expect(result.stdout).not.toContain("Continue? [y/N]");

      const launchResult = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf("{")));
      expect(launchResult.exitCode).toBe(0);

      const invocation = await readJson<{ cwd: string; argv: string[] }>(capturePath);
      expect(invocation.cwd).toBe(scenario.working);
      expect(invocation.argv).toContain("--add-dir");
    },
  );

  test("claude setup writes companion guidance artifacts", async () => {
    const scenario = await createScenario("mate-cli-e2e-claude-guidance-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    await fs.access(path.join(scenario.companion, "AGENTS.md"));
    await fs.access(path.join(scenario.companion, "CLAUDE.md"));
    await expect(
      fs.access(path.join(scenario.companion, ".claude", "CLAUDE.md")),
    ).rejects.toThrow();
  });
});
