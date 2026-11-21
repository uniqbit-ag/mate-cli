/**
 * Agent end-to-end test of the Delivery Path: `bun test/agent-e2e/run.ts [--all] [--only <id>]`.
 *
 * Each scenario runs one real headless Claude Code session (`claude -p`) against this checkout's
 * `mate` and skill templates, in a sanitized temporary companion and Working Repository, and then
 * checks the change's Delivery Record, its tasks, the companion's own steps that ran, and the
 * hand-off the response ends with. Not part of `bun run test`: it needs a signed-in `claude`, the
 * OpenSpec dependency installed, and it spends tokens. The model is the smallest one by default;
 * `MATE_AGENT_E2E_MODEL` overrides it.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type * as GuidanceModule from "../../packages/mate-core/src/playbooks/companion-guidance";
import type * as TurnModule from "../../packages/mate-core/src/runtime/workflow/turn";
import { CHANGE, customSkill, DEFAULT_TASKS, SCENARIOS, type Scenario } from "./scenarios";

const ROOT = path.resolve(import.meta.dirname, "../..");
/**
 * The `@uniqbit/mate-core` package sessions run against; this checkout's by default.
 * `MATE_AGENT_E2E_CORE` names an installed one, with `MATE_AGENT_E2E_MATE` its `mate` entry, to
 * test a packed install instead of the source tree.
 */
const CORE = process.env.MATE_AGENT_E2E_CORE ?? path.join(ROOT, "packages/mate-core");
/** How the turn hook reads a turn's reports from its shell commands. */
const { reportedSteps } = (await import(
  path.join(CORE, "src/runtime/workflow/turn.ts")
)) as typeof TurnModule;
const { buildCompanionGuidance } = (await import(
  path.join(CORE, "src/playbooks/companion-guidance.ts")
)) as typeof GuidanceModule;
/**
 * The plugin's turn-hook groups from its `hooks.json`, with the plugin root filled in, each run
 * under `home`, the fixture's `mate` home.
 */
async function turnHookGroups(
  pluginRoot: string,
  home: string,
): Promise<Record<string, unknown[]>> {
  const wiring = JSON.parse(await fs.readFile(path.join(pluginRoot, "hooks/hooks.json"), "utf8"))
    .hooks as Record<string, unknown[]>;
  const groups = Object.entries(wiring).flatMap(([event, entries]) => {
    const turn = entries.filter((entry) => JSON.stringify(entry).includes("workflow-turn.mjs"));
    return turn.length > 0 ? [[event, turn] as const] : [];
  });
  return JSON.parse(
    JSON.stringify(Object.fromEntries(groups))
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot)
      .replaceAll(
        '"command":"node ',
        `"command":${JSON.stringify(`HOME="${home}" node `).slice(0, -1)}`,
      ),
  ) as Record<string, unknown[]>;
}
/** The turn hook a Mate launch loads; `MATE_AGENT_E2E_TURN_HOOKS=off` leaves it out to compare. */
const TURN_HOOKS = process.env.MATE_AGENT_E2E_TURN_HOOKS !== "off";
const TEMPLATES = path.join(CORE, "src/templates");
/**
 * The stage skills sessions load; this checkout's by default. `MATE_AGENT_E2E_SKILLS` names
 * another `mate-skills/claude` folder, such as one exported from main, to compare against it.
 */
const SKILLS = process.env.MATE_AGENT_E2E_SKILLS ?? path.join(TEMPLATES, "mate-skills/claude");
const HANDOFF_ONLY = process.env.MATE_AGENT_E2E_HANDOFF_ONLY === "1";
const MATE_BIN =
  process.env.MATE_AGENT_E2E_MATE ?? path.join(ROOT, "apps/mate-cli/src/cli-bootstrap.cjs");
const WRAPPER_BIN = path.join(CORE, "wrappers/bin");
/**
 * `MATE_AGENT_E2E_RUNTIME=opencode` runs each session with `opencode run` instead: guidance in
 * the repository's `AGENTS.md`, skills in `.agents/skills/`, invoked with `@`, and the turn hook
 * of Mate's OpenCode plugin on a private server. The shell marker the plugin sets is set for it.
 */
const RUNTIME = process.env.MATE_AGENT_E2E_RUNTIME === "opencode" ? "opencode" : "claude";
const PREFIX = RUNTIME === "opencode" ? "@" : "/";
const MODEL =
  process.env.MATE_AGENT_E2E_MODEL ?? (RUNTIME === "opencode" ? "openai/gpt-5.6-luna" : "haiku");
const TIMEOUT_MS = 12 * 60_000;
const CONCURRENCY = 5;
const ATTEMPTS = Number(process.env.MATE_AGENT_E2E_ATTEMPTS ?? 2);
const REPOSITORY = "acme/acme-app";
const BRANCH = `workset/${CHANGE}`;

const DELTA = `<!-- mate:delta
change: ${CHANGE}
capability: acme-greeting
scopes:
  - repository: ${REPOSITORY}
    area: .
-->

## ADDED Requirements

### Requirement: The repository greets

The repository SHALL hold \`greeting.txt\` with a greeting line and a farewell line.
**Area:** \`.\`

#### Scenario: Greeting present
- **WHEN** the repository is read
- **THEN** \`greeting.txt\` holds \`hello acme\`, then \`goodbye acme\`
`;

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

interface Fixture {
  root: string;
  companion: string;
  repo: string;
  bin: string;
}

/** The change's folder in `companion`. */
function changeDir(scenario: Scenario, companion: string): string {
  return path.join(companion, scenario.folder?.path ?? `openspec/changes/${CHANGE}`);
}

/** Where the fixture's `mate` logs each `workflow done` it ran that succeeded, its arguments. */
function reportLog(root: string): string {
  return path.join(root, "reported");
}

/** The reports the fixture's `mate` recorded, in order: as the turn hook counts them. */
function recordedReports(fixture: Fixture): { skill: string; change: string }[] {
  let log = "";
  try {
    log = readFileSync(reportLog(fixture.root), "utf8");
  } catch {
    // No report recorded.
  }
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [, , skill = "", change = ""] = line
        .split(/\s+/)
        .filter((word) => !word.startsWith("-"));
      return { skill, change };
    });
}

/** The environment a session and the checks run `mate` in. */
function mateEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [fixture.bin, WRAPPER_BIN, process.env.PATH].join(path.delimiter),
    MATE_ARTIFACT_PATH: fixture.companion,
    MATE_REPO_PATH: fixture.repo,
    MATE_WRAPPER_BIN_PATH: WRAPPER_BIN,
  };
}

/** A companion holding one planned change, and its Working Repository on the delivery branch. */
async function createFixture(scenario: Scenario): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-agent-e2e-")));
  const companion = path.join(root, "acme-companion");
  const repo = path.join(root, "acme-app");
  const bin = path.join(root, "bin");
  const change = changeDir(scenario, companion);

  await write(path.join(companion, "openspec", "config.yaml"), "schema: mate-minimal\n");
  await fs.mkdir(path.join(companion, "openspec", "specs"), { recursive: true });
  await fs.cp(
    path.join(TEMPLATES, "capabilities/openspec-cap/mate-minimal"),
    path.join(companion, "openspec/schemas/mate-minimal"),
    { recursive: true },
  );
  if (scenario.folder) {
    for (const [file, content] of Object.entries(scenario.folder.files)) {
      // oxlint-disable-next-line no-await-in-loop -- a few small files
      await write(path.join(change, file), content);
    }
  } else {
    await write(path.join(change, ".openspec.yaml"), "schema: mate-minimal\ncreated: 2026-11-18\n");
    await write(path.join(change, "specs/acme-greeting/spec.md"), DELTA);
    await write(path.join(change, "tasks.md"), scenario.tasks ?? DEFAULT_TASKS);
  }
  const recorded = Object.entries(scenario.recorded ?? {})
    .map(([stage, steps]) => `  ${stage}: [${steps.join(", ")}]\n`)
    .join("");
  await write(
    path.join(change, "delivery.yaml"),
    `version: 1\nchange: ${CHANGE}\n${recorded ? `stages:\n${recorded}` : ""}deliveries:\n  - repository: ${REPOSITORY}\n    branch: ${BRANCH}\n`,
  );
  if (scenario.workflow) {
    await write(path.join(companion, ".mate/config/workflow.yaml"), scenario.workflow);
  }

  await write(path.join(repo, "README.md"), "# Acme App\n");
  // A delivery scenario commits them on the delivery branch instead.
  if (!scenario.delivery) {
    for (const [file, content] of Object.entries(scenario.files ?? {})) {
      // oxlint-disable-next-line no-await-in-loop -- a few small files
      await write(path.join(repo, file), content);
    }
  }
  // The stage skills as a launch installs them, and the companion's own skills beside them.
  const stageSkills = scenario.delivery
    ? ["mate-apply-change", "mate-submit-change"]
    : ["mate-apply-change"];
  for (const skill of stageSkills) {
    // oxlint-disable-next-line no-await-in-loop -- a few skill folders
    await fs.cp(path.join(SKILLS, skill), path.join(repo, ".claude/skills", skill), {
      recursive: true,
    });
    if (RUNTIME === "opencode") {
      // oxlint-disable-next-line no-await-in-loop
      await fs.cp(
        path.join(TEMPLATES, "mate-skills/agents", skill),
        path.join(repo, ".agents/skills", skill),
        { recursive: true },
      );
    }
  }
  const skillsDir = RUNTIME === "opencode" ? ".agents/skills" : ".claude/skills";
  for (const skill of scenario.skills ?? []) {
    for (const home of [repo, companion]) {
      // oxlint-disable-next-line no-await-in-loop -- two small files
      await write(
        path.join(home, skillsDir, skill, "SKILL.md"),
        customSkill(skill, scenario.closes?.[skill], scenario.loop),
      );
    }
  }
  // The plugin's turn hook alone: its other hooks would act on the developer's real home.
  if (TURN_HOOKS) {
    await write(
      path.join(repo, ".claude/settings.json"),
      `${JSON.stringify({ hooks: await turnHookGroups(path.join(CORE, "claude-plugin"), path.join(root, "home")) }, null, 2)}\n`,
    );
  }
  // Without `mate wrap`, a config of its own keeps the OpenSpec wrapper on the companion quietly.
  await write(path.join(repo, "openspec/config.yml"), "");
  await write(path.join(repo, ".gitignore"), ".claude/\n.agents/\nAGENTS.md\nopenspec/\n");
  git(repo, "init", "-q", "-b", "main");
  identify(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  if (!scenario.delivery) {
    git(repo, "remote", "add", "origin", `https://github.com/${REPOSITORY}.git`);
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(repo, "switch", "-qc", BRANCH);
  }

  // `mate` refreshes its runtime directory under HOME on every run; a home of its own keeps this
  // checkout's build from re-pointing the developer's installed runtime. The turn hooks keep their
  // state under the same home, so the steps `mate workflow done` notes reach them. Each recorded
  // report is also logged, as the hook counts it.
  await fs.mkdir(path.join(root, "home"), { recursive: true });
  await write(
    path.join(bin, "mate"),
    [
      "#!/bin/sh",
      `HOME="${path.join(root, "home")}" node "${MATE_BIN}" "$@"`,
      "status=$?",
      `if [ "$status" -eq 0 ] && [ "$1" = workflow ] && [ "$2" = done ]; then printf '%s\\n' "$*" >> "${reportLog(root)}"; fi`,
      'exit "$status"',
      "",
    ].join("\n"),
  );
  await fs.chmod(path.join(bin, "mate"), 0o755);
  // What a companion's own skill runs: a marker per step, outside both repositories.
  await write(
    path.join(bin, "acme-step"),
    `#!/bin/sh\nmkdir -p "${path.join(root, "steps")}" && printf '%s\\n' "$2" >> "${path.join(root, "steps")}/$1"\n`,
  );
  await fs.chmod(path.join(bin, "acme-step"), 0o755);
  const fixture = { root, companion, repo, bin };
  if (scenario.delivery) await addRemotes(scenario, fixture);
  return fixture;
}

/** Commits as Acme, so no real name reaches a fixture's history. */
function identify(cwd: string): void {
  git(cwd, "config", "user.name", "Acme");
  git(cwd, "config", "user.email", "acme@example.com");
}

/** The companion's bare remote, where submit pushes its inbox. */
const companionRemote = (fixture: Fixture): string => path.join(fixture.root, "companion.git");

/**
 * Bare remotes for a delivery scenario: the companion's, and the app's under `remotes/`, reached
 * as `git@github.com:acme/acme-app.git` through an SSH stub so its identity still parses. The
 * delivery branch holds the scenario's files, pushed.
 */
async function addRemotes(scenario: Scenario, fixture: Fixture): Promise<void> {
  const { root, companion, repo } = fixture;
  const remotes = path.join(root, "remotes");
  git(root, "init", "-q", "--bare", "-b", "main", path.join(remotes, `${REPOSITORY}.git`));
  const stub = path.join(root, "ssh-stub");
  await write(stub, `#!/bin/sh\nfor last; do :; done\ncd "${remotes}" && exec sh -c "$last"\n`);
  await fs.chmod(stub, 0o755);
  git(repo, "config", "core.sshCommand", stub);
  git(repo, "remote", "add", "origin", `git@github.com:${REPOSITORY}.git`);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  git(repo, "switch", "-qc", BRANCH);
  for (const [file, content] of Object.entries(scenario.files ?? {})) {
    // oxlint-disable-next-line no-await-in-loop -- a few small files
    await write(path.join(repo, file), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "greet");
  git(repo, "push", "-q", "-u", "origin", BRANCH);

  // Everything but the change, which reaches the remote only by being submitted.
  git(root, "init", "-q", "--bare", "-b", "main", companionRemote(fixture));
  git(companion, "init", "-q", "-b", "main");
  identify(companion);
  const changePath = path.relative(companion, changeDir(scenario, companion));
  git(companion, "add", "-A", "--", ".", `:(exclude)${changePath}`);
  git(companion, "commit", "-qm", "init");
  git(companion, "remote", "add", "origin", companionRemote(fixture));
  git(companion, "push", "-q", "-u", "origin", "main");
  git(companion, "remote", "set-head", "origin", "main");
}

/** Whether `text` names `item` in the CLI's `/` prefix or the runtime's. */
const names = (text: string, item: string): boolean =>
  text.includes(item) || text.includes(inSyntax(item));

/** Where `handoff` departs from the scenario's expected hand-off; `label` names whose it is. */
function handoffProblems(label: string, handoff: string, scenario: Scenario): string[] {
  return [
    ...scenario.expect.handoff
      .filter((item) => !names(handoff, item))
      .map((item) => `${label} lacks ${item}`),
    ...(scenario.expect.notHandoff ?? [])
      .filter((item) => names(handoff, item))
      .map((item) => `${label} names ${item}`),
  ];
}

/**
 * The turn hook's hand-offs against the expected one: the one it holds the response to at
 * `Stop`, asked of Mate as the hook asks, after the turn's last report; and each it sent back or
 * showed. A send-back calling an expected action extra is a false one.
 */
function hookProblems(scenario: Scenario, fixture: Fixture, session: Session): string[] {
  const problems: string[] = [];
  // What `mate workflow done` recorded, else, as the hook falls back, the commands' text.
  const recorded = recordedReports(fixture);
  const reports = recorded.length > 0 ? recorded : session.commands.flatMap(reportedSteps);
  const last = reports.findLast((report) => report.change);
  if (last) {
    const next = spawnSync(
      path.join(fixture.bin, "mate"),
      ["workflow", "next", last.change, "--json", "--after", last.skill],
      { cwd: fixture.repo, encoding: "utf8", env: mateEnv(fixture) },
    );
    const json = next.stdout.split("\n").findLast((line) => line.startsWith("{")) ?? "{}";
    const printed = JSON.parse(json) as { ok?: boolean; handoff?: string };
    const handoff = printed.ok ? (printed.handoff ?? "") : "";
    problems.push(...handoffProblems("the hook's hand-off", handoff, scenario));
  }
  for (const reason of session.sendBacks) {
    // A send-back asking for the report holds no hand-off, only its section's name.
    const at = reason.indexOf("\n\n## Next steps\n");
    if (at >= 0) problems.push(...handoffProblems("a send-back", reason.slice(at), scenario));
    const extra = /lists (.+?), which Mate did not print/.exec(reason)?.[1] ?? "";
    for (const item of scenario.expect.handoff.filter((action) => names(extra, action))) {
      problems.push(`a send-back calls ${item} extra`);
    }
  }
  for (const notice of session.notices) {
    problems.push(...handoffProblems("a hook notice", notice, scenario));
  }
  return problems;
}

/** Whether the companion's remote lacks a change expected submitted. */
function remoteProblems(scenario: Scenario, fixture: Fixture): string[] {
  const bare = companionRemote(fixture);
  const changePath = path.relative(fixture.companion, changeDir(scenario, fixture.companion));
  const inbox = spawnSync(
    "git",
    ["--git-dir", bare, "show", `mate/inbox:${changePath}/delivery.yaml`],
    { encoding: "utf8" },
  );
  const inInbox = inbox.status === 0 && /^state: submitted$/m.test(inbox.stdout);
  return scenario.expect.submitted && !inInbox ? ["the inbox holds no submitted change"] : [];
}

interface Session {
  /** The final response. */
  result: string;
  /** Every shell command the session ran. */
  commands: string[];
  turns: number;
  cost: number;
  error?: string;
  /** What the turn hook sent back, each its reason, and the hand-offs it only showed. */
  sendBacks: string[];
  notices: string[];
}

/** `text` with each `/skill` invocation in the runtime's syntax. */
const inSyntax = (text: string): string =>
  PREFIX === "/" ? text : text.replace(/(^|\s)\/(?=[a-z])/g, `$1${PREFIX}`);

/**
 * The environment OpenCode runs in. An empty config home: the developer's global plugins,
 * instructions and MCP servers stay out, and their sign-in, kept under the data home, still works.
 */
function openCodeEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    ...mateEnv(fixture),
    MATE_AGENT_RUNTIME: "opencode",
    XDG_CONFIG_HOME: path.join(fixture.root, "xdg-config"),
    // OpenCode takes its project from `PWD`, which `cwd` alone leaves at the caller's folder.
    PWD: fixture.repo,
  };
}

/** The prompt in `opencode run`; the guidance comes from the repository's `AGENTS.md`. */
async function runOpenCodeSession(
  scenario: Scenario,
  fixture: Fixture,
  guidance: string,
): Promise<Session> {
  await write(path.join(fixture.repo, "AGENTS.md"), `${guidance}\n`);
  if (TURN_HOOKS) return runOpenCodeServed(scenario, fixture);
  const args = ["run", "--standalone", "--auto", "--model", MODEL, "--format", "json"];
  const child = spawn("opencode", [...args, inSyntax(scenario.prompt)], {
    cwd: fixture.repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: openCodeEnv(fixture),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  await write(path.join(fixture.root, "session.jsonl"), stdout);

  const session: Session = {
    result: "",
    commands: [],
    turns: 0,
    cost: 0,
    sendBacks: [],
    notices: [],
  };
  // The response is the text after the last tool call.
  let texts: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; part?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    const part = event.part ?? {};
    if (event.type === "tool_use") {
      texts = [];
      const command = (part.state as { input?: { command?: unknown } } | undefined)?.input?.command;
      if (typeof command === "string") session.commands.push(command);
    }
    if (event.type === "text" && typeof part.text === "string") texts.push(part.text);
    if (event.type === "step_finish") {
      session.turns += 1;
      session.cost += Number(part.cost ?? 0);
    }
  }
  session.result = texts.join("\n");
  if (code !== 0) session.error = `opencode exited ${code}: ${stderr.trim().slice(0, 400)}`;
  return session;
}

/** A plugin loading only the turn hook: Mate's others would act on the developer's real home. */
function turnHookPlugin(fixture: Fixture): string {
  const module = JSON.stringify(path.join(CORE, "src/opencode/turn-hook.ts"));
  return `import { registerTurnHook, spawnNextHandoff } from ${module};

export default {
  id: "mate-e2e-turn-hook",
  async setup(api) {
    return registerTurnHook(api, {
      companionPath: ${JSON.stringify(fixture.companion)},
      nextHandoff: spawnNextHandoff(${JSON.stringify(path.join(fixture.bin, "mate"))}, process.env),
      env: process.env,
      // The fixture's \`mate\` notes its steps under its own home.
      stateDir: ${JSON.stringify(path.join(fixture.root, "home", ".mate", "turn-hooks"))},
    });
  },
};
`;
}

/** Runs `opencode <args>` to its end; stdout and the exit code. */
function opencode(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("opencode", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

interface ExportedMessage {
  type?: string;
  /** A synthetic message's text and the plugin's label for it. */
  text?: string;
  description?: string;
  content?: Array<{ type?: string; text?: unknown; name?: string; state?: { input?: unknown } }>;
}

/**
 * With the turn hook on: `opencode run --standalone` ends after the first execution, before a
 * turn the hook sends back resumes. A private server keeps the session running; the session is
 * read from its export once it has stayed idle.
 */
async function runOpenCodeServed(scenario: Scenario, fixture: Fixture): Promise<Session> {
  await write(
    path.join(fixture.root, "xdg-config/opencode/plugins/mate-turn-hook.js"),
    turnHookPlugin(fixture),
  );
  const env = { ...openCodeEnv(fixture), OPENCODE_PASSWORD: crypto.randomUUID() };
  const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: fixture.repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const session: Session = {
    result: "",
    commands: [],
    turns: 0,
    cost: 0,
    sendBacks: [],
    notices: [],
  };
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("opencode serve did not start")), 30_000);
      server.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const match = /listening on (http:\/\/\S+)/.exec(out);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
    });
    const run = await opencode(
      ["run", "--server", url, "--auto", "--model", MODEL, "--format", "json"].concat(
        inSyntax(scenario.prompt),
      ),
      env,
      fixture.repo,
    );
    await write(path.join(fixture.root, "session.jsonl"), run.stdout);
    const id = /"sessionID":"([^"]+)"/.exec(run.stdout)?.[1];
    if (!id) {
      session.error = `opencode run exited ${run.code}: ${run.stderr.trim().slice(0, 400)}`;
      return session;
    }

    // Idle, and no hand-off check queued after it, for three polls in a row.
    let exported: { info?: { cost?: number }; messages?: ExportedMessage[] } = {};
    const deadline = Date.now() + TIMEOUT_MS;
    for (let calm = 0, seen = -1; calm < 3 && Date.now() < deadline;) {
      // oxlint-disable-next-line no-await-in-loop -- polling
      await new Promise((resolve) => setTimeout(resolve, 3000));
      // oxlint-disable-next-line no-await-in-loop -- polling
      const result = await opencode(["session", "export", "--server", url, id], env, fixture.repo);
      try {
        exported = JSON.parse(result.stdout) as typeof exported;
      } catch {
        continue;
      }
      const messages = exported.messages ?? [];
      const idle = messages.at(-1)?.type === "idle";
      calm = idle && messages.length === seen ? calm + 1 : 0;
      seen = messages.length;
    }
    await write(path.join(fixture.root, "export.json"), JSON.stringify(exported, null, 2));

    const messages = exported.messages ?? [];
    const start = messages.findLastIndex((m) => m.type === "user" || m.type === "synthetic");
    for (const [index, message] of messages.entries()) {
      if (message.type === "synthetic" && message.description === "Mate hand-off check") {
        session.sendBacks.push(String(message.text ?? ""));
      }
      if (message.type !== "assistant") continue;
      session.turns += 1;
      for (const part of message.content ?? []) {
        const command = (part.state?.input as { command?: unknown } | undefined)?.command;
        if (part.type === "tool" && typeof command === "string") session.commands.push(command);
      }
      if (index > start) {
        const texts = (message.content ?? []).filter((part) => part.type === "text");
        session.result = [session.result, ...texts.map((part) => String(part.text))]
          .filter(Boolean)
          .join("\n");
      }
    }
    session.cost = Number(exported.info?.cost ?? 0);
    return session;
  } catch (error) {
    session.error = (error as Error).message;
    return session;
  } finally {
    server.kill();
  }
}

/** Runs the scenario's prompt in a headless session; its event stream is kept beside the fixture. */
async function runSession(scenario: Scenario, fixture: Fixture): Promise<Session> {
  if (RUNTIME === "opencode") {
    return runOpenCodeSession(scenario, fixture, buildGuidance(fixture));
  }
  const guidance = buildGuidance(fixture);
  const args = [
    "-p",
    scenario.prompt,
    "--model",
    MODEL,
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "project",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash,Read,Write,Edit,Glob,Grep,Skill",
    "--append-system-prompt",
    guidance,
  ];
  return runClaudeSession(fixture, args);
}

function buildGuidance(fixture: Fixture): string {
  return buildCompanionGuidance(
    {
      companionPath: fixture.companion,
      repository: { id: "acme-app", path: fixture.repo },
      capabilities: [{ name: "openspec" }],
    },
    { wrapperBinPath: WRAPPER_BIN },
  );
}

const STOP_FEEDBACK = "Stop hook feedback:\n";

async function runClaudeSession(fixture: Fixture, args: string[]): Promise<Session> {
  const child = spawn("claude", args, {
    cwd: fixture.repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: mateEnv(fixture),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  await write(path.join(fixture.root, "session.jsonl"), stdout);

  const session: Session = {
    result: "",
    commands: [],
    turns: 0,
    cost: 0,
    sendBacks: [],
    notices: [],
  };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      const content = (event.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const block of content as Array<Record<string, unknown>>) {
        const command = (block.input as { command?: unknown } | undefined)?.command;
        if (block.type === "tool_use" && typeof command === "string") {
          session.commands.push(command);
        }
      }
    }
    // A blocking `Stop` hook resumes the session with its reason; a notice is shown beside it.
    const content = (event.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as Array<Record<string, unknown>>) {
      const said = typeof block.text === "string" ? block.text : "";
      if (event.type === "user" && said.startsWith(STOP_FEEDBACK)) {
        session.sendBacks.push(said.slice(STOP_FEEDBACK.length));
      }
    }
    if (event.type === "system" && line.includes("Mate hand-off:")) session.notices.push(line);
    if (event.type === "result") {
      session.result = typeof event.result === "string" ? event.result : "";
      session.turns = Number(event.num_turns ?? 0);
      session.cost = Number(event.total_cost_usd ?? 0);
      if (event.is_error) session.error = `the session ended in an error: ${session.result}`;
    }
  }
  if (code !== 0 && !session.error) {
    session.error = `claude exited ${code}: ${stderr.trim().slice(0, 400)}`;
  }
  return session;
}

/** What the session left that the scenario did not expect; empty when it passed. */
/**
 * What a default-path session promises on main as on this branch: the tasks are done, and the
 * response ends with a `## Next steps` section naming the right next skill. With open tasks
 * main lists them before `/mate-submit-change` and this branch names `/mate-apply-change`, so
 * either counts. Used to compare the two with `MATE_AGENT_E2E_HANDOFF_ONLY=1`.
 */
async function checkHandoffOnly(scenario: Scenario, fixture: Fixture, session: Session) {
  const problems: string[] = [];
  if (session.error) problems.push(session.error);
  const tasks = await fs.readFile(
    path.join(fixture.companion, "openspec", "changes", CHANGE, "tasks.md"),
    "utf8",
  );
  const open = tasks.split("\n").filter((line) => /^\s*- \[ \]/.test(line)).length;
  if (open !== scenario.expect.openTasks) {
    problems.push(`${open} open tasks, expected ${scenario.expect.openTasks}`);
  }
  const at = session.result.lastIndexOf("## Next steps");
  if (at < 0) return [...problems, "the response has no Next steps section"];
  const section = session.result.slice(at);
  const submit = `/mate-submit-change ${CHANGE}`;
  const valid = open === 0 ? [submit] : [submit, `/mate-apply-change ${CHANGE}`];
  if (!valid.some((text) => section.includes(text))) {
    problems.push(`the hand-off names none of ${valid.join(", ")}`);
  }
  return problems;
}

async function check(scenario: Scenario, fixture: Fixture, session: Session): Promise<string[]> {
  if (HANDOFF_ONLY) return checkHandoffOnly(scenario, fixture, session);
  const problems: string[] = [];
  if (session.error) problems.push(session.error);
  const change = changeDir(scenario, fixture.companion);

  const record = Bun.YAML.parse(await fs.readFile(path.join(change, "delivery.yaml"), "utf8")) as {
    stages?: Record<string, string[]>;
  };
  const stages = JSON.stringify(record.stages ?? {});
  if (stages !== JSON.stringify(scenario.expect.stages)) {
    problems.push(`recorded stages ${stages}, expected ${JSON.stringify(scenario.expect.stages)}`);
  }

  if (scenario.expect.at !== undefined) {
    // Where the CLI alone puts the change, whatever the response says.
    const next = spawnSync(path.join(fixture.bin, "mate"), ["workflow", "next", CHANGE, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: mateEnv(fixture),
    });
    // The first `mate` run in the fixture's home prints its runtime repair before the JSON.
    const json = next.stdout.split("\n").findLast((line) => line.startsWith("{")) ?? "{}";
    const stage = (JSON.parse(json) as { stage?: string }).stage ?? next.stderr;
    if (stage !== scenario.expect.at) {
      problems.push(`the change is at ${stage}, expected ${scenario.expect.at}`);
    }
  }

  if (scenario.expect.openTasks !== undefined) {
    const tasks = await fs.readFile(path.join(change, "tasks.md"), "utf8");
    const open = tasks.split("\n").filter((line) => /^\s*- \[ \]/.test(line)).length;
    if (open !== scenario.expect.openTasks) {
      problems.push(`${open} open tasks, expected ${scenario.expect.openTasks}`);
    }
  }

  const ran: Array<{ skill: string; at: number }> = [];
  for (const skill of scenario.skills ?? []) {
    const marker = path.join(fixture.root, "steps", skill);
    // oxlint-disable-next-line no-await-in-loop -- a few markers
    const stat = await fs.stat(marker).catch(() => null);
    if (stat) ran.push({ skill, at: stat.mtimeMs });
  }
  const order = ran.toSorted((a, b) => a.at - b.at).map((entry) => entry.skill);
  const expected = scenario.expect.ran ?? [];
  if (JSON.stringify(order) !== JSON.stringify(expected)) {
    problems.push(`own steps ran: [${order.join(", ")}], expected [${expected.join(", ")}]`);
  }

  problems.push(...remoteProblems(scenario, fixture));
  problems.push(...hookProblems(scenario, fixture, session));

  if (!session.commands.some((command) => /\bmate workflow done\b/.test(command))) {
    problems.push("the session never ran mate workflow done");
  }
  const at = session.result.lastIndexOf("## Next steps");
  if (at < 0) {
    problems.push("the response has no Next steps section");
  } else {
    const section = session.result.slice(at);
    for (const text of scenario.expect.handoff.map(inSyntax)) {
      if (!section.includes(text)) problems.push(`the hand-off lacks ${text}`);
    }
    for (const text of (scenario.expect.notHandoff ?? []).map(inSyntax)) {
      if (section.includes(text)) problems.push(`the hand-off names ${text}`);
    }
  }
  return problems;
}

interface Outcome {
  scenario: Scenario;
  fixture: Fixture;
  session: Session;
  problems: string[];
  seconds: number;
}

/**
 * Runs the scenario in a fresh fixture, once more when the first session misses: a session is
 * not deterministic, and the smallest model now and then rewords the section it should copy.
 * `MATE_AGENT_E2E_ATTEMPTS=1` turns the second attempt off, to measure how often that happens.
 */
async function runScenario(scenario: Scenario): Promise<Outcome> {
  let outcome: Outcome | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const started = Date.now();
    // oxlint-disable-next-line no-await-in-loop -- one attempt after the other
    const fixture = await createFixture(scenario);
    // oxlint-disable-next-line no-await-in-loop
    const session = await runSession(scenario, fixture);
    // oxlint-disable-next-line no-await-in-loop
    const problems = await check(scenario, fixture, session);
    const seconds = Math.round((Date.now() - started) / 1000);
    const mark = problems.length === 0 ? "pass" : attempt < ATTEMPTS ? "miss" : "FAIL";
    const hooked = session.sendBacks.length + session.notices.length;
    const note =
      (hooked > 0
        ? `, hook: ${session.sendBacks.length} sent back, ${session.notices.length} shown`
        : "") + (attempt > 1 ? `, attempt ${attempt}` : "");
    console.log(`${mark}  ${scenario.id}  (${seconds}s, ${session.turns} turns${note})`);
    if (mark === "miss") console.log(`      ${problems.join("; ")}`);
    outcome = { scenario, fixture, session, problems, seconds };
    if (problems.length === 0) break;
  }
  return outcome!;
}

type Kind = "default" | "mixed" | "custom";

/** No workflow; one mixing Mate's stage skills with the companion's; or the companion's alone. */
function kindOf(scenario: Scenario): Kind {
  if (!scenario.workflow) return "default";
  return /skill: mate-(?!submit-change|publish-artifact)/.test(scenario.workflow)
    ? "mixed"
    : "custom";
}

/** `kind=n,…` as n runs per kind, spread evenly over its scenarios, delivery scenarios first. */
function mixed(spec: string): Scenario[] {
  return spec.split(",").flatMap((part) => {
    const [kind, count] = part.split("=");
    const pool = SCENARIOS.filter((scenario) => kindOf(scenario) === kind).toSorted(
      (a, b) => Number(Boolean(b.delivery)) - Number(Boolean(a.delivery)),
    );
    if (pool.length === 0) throw new Error(`no ${kind} scenario`);
    return Array.from({ length: Number(count) }, (_, index) => pool[index % pool.length]!);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `--only a,b` selects scenarios by id; `--default` the scenarios without a workflow.
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
  const ids = only?.split(",");
  // `--repeat <n>` runs each selected scenario n times, to measure how often a session misses.
  const repeat = argv.includes("--repeat") ? Number(argv[argv.indexOf("--repeat") + 1]) : 1;
  // `--mix default=50,mixed=25,custom=25` spreads that many runs over each kind's scenarios.
  const mix = argv.includes("--mix") ? argv[argv.indexOf("--mix") + 1] : undefined;
  const selected = mix
    ? mixed(mix)
    : SCENARIOS.filter((scenario) =>
        ids
          ? ids.includes(scenario.id)
          : argv.includes("--default")
            ? scenario.workflow === undefined
            : argv.includes("--all") || scenario.core,
      ).flatMap((scenario) => Array.from({ length: repeat }, () => scenario));
  if (selected.length === 0) throw new Error(`no scenario matches ${only ?? "the selection"}`);
  console.log(`Running ${selected.length} agent scenarios with ${RUNTIME} model ${MODEL}`);

  const queue = [...selected];
  const outcomes: Outcome[] = [];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      // oxlint-disable-next-line no-await-in-loop -- a bounded pool
      outcomes.push(await runScenario(next));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));

  const failed = outcomes.filter((outcome) => outcome.problems.length > 0);
  for (const outcome of failed) {
    console.log(`\n${outcome.scenario.id}: ${outcome.scenario.title}`);
    for (const problem of outcome.problems) console.log(`  - ${problem}`);
    console.log(`  kept: ${outcome.fixture.root}`);
    console.log(`  response ends: ${JSON.stringify(outcome.session.result.slice(-500))}`);
  }
  for (const outcome of outcomes) {
    if (outcome.problems.length === 0 && !process.env.MATE_AGENT_E2E_KEEP) {
      // oxlint-disable-next-line no-await-in-loop -- a few folders
      await fs.rm(outcome.fixture.root, { recursive: true, force: true });
    }
  }
  if (outcomes.length > SCENARIOS.length) {
    console.log("");
    for (const scenario of SCENARIOS) {
      const runs = outcomes.filter((outcome) => outcome.scenario.id === scenario.id);
      if (runs.length === 0) continue;
      const passed = runs.filter((outcome) => outcome.problems.length === 0).length;
      const sent = runs.reduce((sum, outcome) => sum + outcome.session.sendBacks.length, 0);
      const shown = runs.reduce((sum, outcome) => sum + outcome.session.notices.length, 0);
      console.log(
        `${kindOf(scenario).padEnd(7)}  ${scenario.id}: ${passed}/${runs.length} passed, hook sent back ${sent}, showed ${shown}`,
      );
    }
  }
  const cost = outcomes.reduce((sum, outcome) => sum + outcome.session.cost, 0);
  console.log(
    `\n${outcomes.length - failed.length} of ${outcomes.length} passed, $${cost.toFixed(2)}`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
