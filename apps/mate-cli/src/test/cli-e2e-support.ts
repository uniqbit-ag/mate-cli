/** Scenario plumbing shared by the `cli-e2e-*.test.ts` files. */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { version } from "../../package.json";

export const APP_ROOT = path.resolve(import.meta.dirname, "../..");

/** Preloaded into every Bun process a test starts, so Mate runs the recording OpenSpec stub. */
const OPENSPEC_STUB_PRELOAD = path.join(import.meta.dirname, "openspec-stub-preload.ts");

const E2E_TMP_ROOT = path.join(os.tmpdir(), "mate-cli-e2e");
const tempRoots: string[] = [];

// Every test here spawns the CLI entrypoint two or three times in sequence. A
// cold Bun start is ~150ms unloaded, but under the parallel load of the whole
// suite it spikes many-fold — enough for a multi-spawn test to blow past Bun's
// 5s default per-test timeout and fail intermittently. Give the entire file a
// generous default; individual tests still override with tighter values where
// a fast failure is the point.
export const DEFAULT_TEST_TIMEOUT_MS = 30_000;
// Watchdog for non-TTY CLI runs. A hung child (e.g. blocked on
// stdin that never arrives) would otherwise sit until the test timeout with no
// diagnostics; killing it early surfaces the captured output instead.
const RUN_MATE_WATCHDOG_MS = 20_000;

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface E2EScenario {
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
}

/** `mate companion open`'s document, named after the working repo root. */
export function workspaceDocument(scenario: E2EScenario): string {
  return path.join(
    scenario.working,
    ".mate",
    `${path.basename(scenario.working)}.mate.code-workspace`,
  );
}

// Returns a PATH string with any directory containing the given command removed.
export function pathWithoutCommand(command: string, pathEnv: string): string {
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

export async function createScenario(prefix: string): Promise<E2EScenario> {
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

const updateStateYaml = (latest: string) =>
  ["lastChecked: 2099-01-01T00:00:00.000Z", `latestVersion: ${latest}`, ""].join("\n");

/**
 * The running version's own channel is fresh with nothing newer; only the other
 * channel caches a newer release, which no command may act on. Keyed to the
 * package version so the seed holds through canary and stable cycles alike.
 */
async function seedUpdateState(home: string): Promise<void> {
  const updateDir = path.join(home, ".mate");
  await fs.mkdir(updateDir, { recursive: true });
  const onCanary = version.includes("-canary.");
  await Promise.all([
    fs.writeFile(
      path.join(updateDir, "update-state-uniqbit-mate.yaml"),
      updateStateYaml(onCanary ? "99.0.0" : "null"),
      "utf8",
    ),
    fs.writeFile(
      path.join(updateDir, "update-state-uniqbit-mate-canary.yaml"),
      updateStateYaml(onCanary ? "null" : "99.0.0"),
      "utf8",
    ),
  ]);
}

export async function runMate(
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
    const child = spawn(process.execPath, [path.join(APP_ROOT, "src/cli.ts"), ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: scenario.home,
        PATH: `${scenario.bin}:${process.env.PATH ?? ""}`,
        ...openSpecStubEnv(scenario),
        TERM_PROGRAM: "",
        VSCODE_IPC_HOOK: "",
        __CFBundleIdentifier: "",
        CI: "", // unset so piped stdin ("y\n") is read normally in spawned processes
        // Prevent dev-environment contamination when running tests inside a Mate-managed agent session
        MATE_ARTIFACT_PATH: "",
        MATE_VERSION: "",
        MATE_REPO_ID: "",
        MATE_REPO_PATH: "",
        MATE_POLICY_JSON: "",
        // Setup would otherwise pre-fetch the pinned OpenCode plugin package
        // into the developer's real OpenCode cache via npm.
        MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH: "1",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
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

const toTclString = (value: string) =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;

export async function runMateInTty(
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
  /**
   * Run through `sh` so mate's exit code reaches us as an output marker: the
   * `wait` builtin blocks indefinitely on this expect build once the child is
   * reaped at eof.
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
  /**
   * Ink frames do not reach expect until the PTY drains at exit, so no output
   * can gate the interaction. The first key instead waits for the prompt to
   * switch the PTY to raw mode: keys typed earlier land in the cooked line
   * buffer and arrive as one chunk the prompt discards. Later keys follow
   * after a fixed `delayMs` (for the final step, long enough to resolve its
   * async preview).
   */
  const sends = inputChunks
    .map((entry) => {
      const step = typeof entry === "string" ? { chunk: entry } : entry;
      return [`after ${step.delayMs ?? 150}`, `send -- ${toTclString(step.chunk)}`].join("\n");
    })
    .join("\n");
  /**
   * `log_user 1` streams the full PTY transcript to stdout, so the caller's
   * captured stdout carries every wizard screen. A process that never closes
   * the PTY trips the timeout branch (exit 124) and still fails the test.
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
        PATH: `${scenario.bin}:${process.env.PATH ?? ""}`,
        ...openSpecStubEnv(scenario),
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
      resolve(withTtyExitCode(exitCode, output, stderr));
    });

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

/**
 * Points Mate at the recording OpenSpec stub once a setup has written it. BUN_OPTIONS
 * splits on whitespace and ignores quotes, so the preload is linked into the scenario's
 * temp root rather than named by its checkout path, which may contain spaces.
 */
export function openSpecStubEnv(scenario: E2EScenario): NodeJS.ProcessEnv {
  const stub = path.join(scenario.bin, "openspec");
  if (!existsSync(stub)) return {};
  const preload = path.join(scenario.root, "openspec-stub-preload.ts");
  if (/\s/.test(preload)) throw new Error(`BUN_OPTIONS cannot name a path with spaces: ${preload}`);
  if (!existsSync(preload)) symlinkSync(OPENSPEC_STUB_PRELOAD, preload);
  const inherited = process.env.BUN_OPTIONS?.trim();
  return {
    BUN_OPTIONS: [inherited, `--preload ${preload}`].filter(Boolean).join(" "),
    MATE_E2E_OPENSPEC_STUB: stub,
  };
}

export async function setupCompanion(
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
  // OpenSpec is a required capability in the CLI distribution, so every
  // setup fixture must provide its binary even when the test omits it.
  await writeOpenSpecStub(scenario);
  // Keep the external command deterministic for provider teardown. Capability
  // activation remains controlled solely by the persisted selection.
  await writeRtkStub(scenario);
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
  ];

  return runMate(scenario, {
    cwd: scenario.companion,
    args: ["companion", "setup", ...selectionArgs, ...extraArgs],
    input: "y\n",
    env,
  });
}

export async function installCompanion(scenario: E2EScenario): Promise<CliRunResult> {
  return runMate(scenario, {
    cwd: scenario.companion,
    args: ["install", "--yes"],
  });
}

export async function linkRepository(scenario: E2EScenario): Promise<CliRunResult> {
  const linkResult = await runMateInTty(scenario, {
    cwd: scenario.working,
    args: ["companion", "link"],
    inputChunks: [
      { chunk: "\x1b[B", delayMs: 1000 },
      { chunk: "\r", delayMs: 1000 },
      { chunk: "\r", delayMs: 1000 },
    ],
    // Cold starts under full-suite load can pass the 8s default before the prompt opens.
    timeoutSeconds: 15,
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

export function initWorkingRepoGit(scenario: E2EScenario): void {
  spawnSync("git", ["init", "-q"], { cwd: scenario.working, stdio: "ignore" });
}

export function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

export async function initCompanionGit(scenario: E2EScenario): Promise<string> {
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

export async function writeAdapterStub(
  scenario: E2EScenario,
  toolName: "claude" | "opencode",
): Promise<string> {
  const capturePath = path.join(scenario.root, `${toolName}-capture.json`);
  const stubPath = path.join(scenario.bin, toolName);
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    ...(toolName === "opencode"
      ? ['if (process.argv[2] === "--version") { console.log("2.0.23"); process.exit(0); }']
      : []),
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
    "    MATE_POLICY_JSON: process.env.MATE_POLICY_JSON ?? null,",
    "    MATE_GUIDANCE_JSON: process.env.MATE_GUIDANCE_JSON ?? null,",
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

export async function writeEditorStub(
  scenario: E2EScenario,
  toolName: "code" | "code-insiders" | "cursor",
): Promise<string> {
  const capturePath = path.join(scenario.root, `${toolName}-capture.json`);
  const stubPath = path.join(scenario.bin, toolName);
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    "const capturePath = process.env.MATE_E2E_EDITOR_CAPTURE_PATH;",
    "if (!capturePath) process.exit(2);",
    'if (process.argv[2] === "--status") process.exit(0);',
    "const payload = { cwd: process.cwd(), argv: process.argv.slice(2) };",
    "fs.writeFileSync(capturePath, JSON.stringify(payload, null, 2));",
    "process.exit(0);",
    "",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);

  return capturePath;
}

export async function writeUvStub(scenario: E2EScenario): Promise<string> {
  const capturePath = path.join(scenario.root, "uv-run-capture.json");
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
    "  process.exit(0);",
    "}",
    "if (sub === 'run') {",
    "  const capturePath = process.env.MATE_E2E_UV_RUN_CAPTURE_PATH;",
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

export async function writeOpenSpecStub(scenario: E2EScenario): Promise<string> {
  const capturePath = path.join(scenario.root, "openspec-capture.json");
  const stubPath = path.join(scenario.bin, "openspec");
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const args = process.argv.slice(2);",
    "const skills = ['openspec-explore', 'openspec-propose', 'openspec-apply-change', 'openspec-archive-change'];",
    "const runtimeDirs = { agents: '.agents', claude: '.claude', opencode: '.opencode' };",
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
    /** Records the store where OpenSpec would, so Mate's registry check sees it. */
    "if (command === 'store' && args[1] === 'register') {",
    "  const [storePath, , id] = args.slice(2);",
    "  fs.mkdirSync(path.join(storePath, '.openspec-store'), { recursive: true });",
    "  fs.writeFileSync(path.join(storePath, '.openspec-store', 'store.yaml'), `version: 1\\nid: ${id}\\n`);",
    "  const dataHome = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME, '.local', 'share');",
    "  const registry = path.join(dataHome, 'openspec', 'stores', 'registry.yaml');",
    "  fs.mkdirSync(path.dirname(registry), { recursive: true });",
    "  fs.writeFileSync(registry, `version: 1\\nstores:\\n  ${id}:\\n    backend:\\n      type: git\\n      local_path: ${storePath}\\n`);",
    "  process.exit(0);",
    "}",
    "if (command === 'config' && args[1] === 'reset') process.exit(0);",
    "if (command === 'update' || command === 'templates') { process.exit(0); }",
    /** The JSON collection commands `mate studio` reads. */
    "if (command === 'list' && args.includes('--specs')) {",
    "  console.log(JSON.stringify({ specs: [{ id: 'acme-checkout', requirementCount: 2 }] }));",
    "  process.exit(0);",
    "}",
    "if (command === 'list') {",
    "  console.log(JSON.stringify({ changes: [{ name: 'add-acme-checkout', completedTasks: 1, totalTasks: 3, status: 'in-progress' }] }));",
    "  process.exit(0);",
    "}",
    "if (command === 'status') {",
    "  console.log(JSON.stringify({ changes: [{ changeName: 'add-acme-checkout', schemaName: 'mate-full', planningHome: { root: process.cwd(), defaultSchema: 'mate-full' }, artifacts: [{ id: 'proposal', status: 'done' }] }] }));",
    "  process.exit(0);",
    "}",
    "if (command === 'validate') {",
    "  console.log(JSON.stringify({ items: [{ id: 'add-acme-checkout', type: 'change', valid: true, issues: [] }] }));",
    "  process.exit(0);",
    "}",
    "process.exit(1);",
    "",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);

  return capturePath;
}

// A tokensave stub for `cap sync`. `sync` writes a real (non-empty) sqlite db so the
// test exercises the steady-state sync path and the capture reflects that invocation.
export async function writeTokensaveSyncStub(scenario: E2EScenario): Promise<string> {
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
    "if (args[0] === 'install' && args[1] === '--agent') {",
    "  const fs = require('node:fs');",
    "  const path = require('node:path');",
    "  const home = process.env.HOME;",
    "  if (args[2] === 'claude') {",
    "    const dir = path.join(home, '.claude');",
    "    fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });",
    "    const file = path.join(dir, 'settings.json');",
    "    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};",
    "    settings.permissions = { ...settings.permissions, allow: [...(settings.permissions?.allow ?? []), 'mcp__tokensave__*'] };",
    "    fs.writeFileSync(file, JSON.stringify(settings));",
    "    fs.writeFileSync(path.join(dir, 'rules', 'tokensave.md'), '');",
    "  }",
    "  if (args[2] === 'opencode') {",
    "    const dir = path.join(home, '.config', 'opencode');",
    "    fs.mkdirSync(dir, { recursive: true });",
    "    const file = path.join(dir, 'opencode.json');",
    "    const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};",
    "    config.mcp = { ...config.mcp, tokensave: {} };",
    "    fs.writeFileSync(file, JSON.stringify(config));",
    "    fs.writeFileSync(path.join(dir, 'tokensave.md'), '');",
    "  }",
    "}",
    "process.exit(0);",
  ].join("\n");

  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

// openEditorWorkspace spawns the editor CLI detached and unref'd so `mate`
// doesn't block on it; the stub may still be starting up when the parent
// process exits, so poll briefly instead of reading the capture file once.
export async function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (
      // oxlint-disable-next-line no-await-in-loop -- polling
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
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
/** Removes the temp roots of the test that just ran; register with `afterEach` in each test file. */
export async function removeScenarios(): Promise<void> {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}
