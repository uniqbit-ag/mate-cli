/** @test-requires containers, network */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findContainerRuntime, TEST_BASE_IMAGE } from "./container-runtime";
import { CONTAINER_ROOT } from "./image-inputs";

/**
 * The supervisor, exercised as the shell script the image actually runs.
 *
 * `mate` and `bun` are replaced by stubs on PATH so each case can pose one
 * outcome — Studio exiting non-zero on its own, an unrelated signal, an
 * operator's termination — and read back what the container reported. Nothing
 * here mocks the supervisor itself.
 *
 * Each case runs inside a container: the script needs bash 5.1 for `wait -n
 * -p`, which the image has and a developer machine may not, so running it
 * against whatever `bash` is first on PATH would test a different program.
 */

const ENTRYPOINT = path.join(CONTAINER_ROOT, "scripts", "entrypoint.sh");
const RUNTIME = findContainerRuntime();
const withContainer = RUNTIME === null ? describe.skip : describe;

/** Paths as the container sees them; the case directory is mounted at /case. */
const CASE = "/case";
const LOG = `${CASE}/processes.log`;
const COMPANION = `${CASE}/companion`;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-supervisor-"));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "companion"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.copyFileSync(ENTRYPOINT, path.join(root, "entrypoint.sh"));
  stubTokensave();
});

afterEach(() => {
  /**
   * The container runs as root and creates the home's directories, which the
   * host user may not be able to remove; clear them from inside first.
   */
  if (RUNTIME !== null) {
    spawnSync(
      RUNTIME,
      [
        "run",
        "--rm",
        "--volume",
        `${root}:${CASE}:z`,
        "--entrypoint",
        "rm",
        TEST_BASE_IMAGE,
        "-rf",
        HOME,
      ],
      { stdio: "ignore" },
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(name: string, body: string): void {
  const file = path.join(root, "bin", name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

/**
 * Stands in for `tokensave install`: records each call and writes the file the
 * real one would, so a rerun is visible as an overwrite. Fails for the agent
 * named in `tokensave-fails`, if any. Package managers and downloaders are
 * stubbed to record themselves, since reconciliation may not invoke them.
 */
function stubTokensave(): void {
  writeExecutable(
    "tokensave",
    `#!/usr/bin/env bash
echo "$*" >> "${CASE}/tokensave.log"
agent="$3"
[[ -f "${CASE}/tokensave-fails" && "$agent" == "$(cat "${CASE}/tokensave-fails")" ]] && exit 3
if [[ "$agent" == claude ]]; then
  mkdir -p "$HOME/.claude/rules" && echo current > "$HOME/.claude/rules/tokensave.md"
else
  echo current > "$HOME/.config/opencode/tokensave.md"
fi
`,
  );
  for (const installer of ["npm", "pnpm", "yarn", "pip", "uv", "cargo", "curl", "wget"]) {
    writeExecutable(
      installer,
      `#!/usr/bin/env bash\necho "${installer} $*" >> "${CASE}/installers.log"\n`,
    );
  }
}

/** Paths as the container sees them, for seeding and reading back the test home. */
const HOME = `${CASE}/home`;
const homeFile = (relative: string) => path.join(root, "home", relative);

/**
 * Stands in for the startup program: prints the plan the supervisor evaluates,
 * so these cases are about the supervisor rather than about discovery.
 */
function stubStartup(
  options: {
    writable?: boolean;
    gitSync?: boolean;
    allowedHosts?: string;
    publicOrigin?: string;
    audience?: string;
  } = {},
): void {
  const writable = options.writable ?? true;
  writeExecutable(
    "bun",
    `#!/usr/bin/env bash
if [[ "\${2:-}" == "--credentials" ]]; then
  echo "export STUB_CREDENTIAL='secret'"
  exit 0
fi
cat <<'PLAN'
MATE_PLAN_COMPANION='${COMPANION}'
MATE_PLAN_STUDIO_PORT='4097'
MATE_PLAN_STUDIO_HOST='0.0.0.0'
MATE_PLAN_STUDIO_WRITABLE='${writable ? "1" : ""}'
MATE_PLAN_STUDIO_TERMINAL='${writable ? "1" : ""}'
MATE_PLAN_STUDIO_DETACH_MINUTES='30'
MATE_PLAN_STUDIO_ALLOWED_HOSTS='${options.allowedHosts ?? ""}'
MATE_PLAN_STUDIO_PUBLIC_ORIGIN='${options.publicOrigin ?? ""}'
MATE_PLAN_GIT_SYNC='${options.gitSync ? "1" : ""}'
MATE_PLAN_AUDIENCE='${options.audience ?? ""}'
PLAN
`,
  );
}

/** Runs until signalled, then reports the signal the way a real child would. */
const RUNS_UNTIL_SIGNALLED = `
trap 'note "$1" stopped; exit 143' TERM
trap 'note "$1" stopped; exit 130' INT
note "$1" ready
while :; do sleep 0.05 & wait $!; done
`;

/** Ends on its own with a given status. */
const endsWith = (status: number) => `sleep 0.4; note "$1" stopped; exit ${status}`;

/**
 * A `mate` whose `studio` behaves as each case needs. Studio also starts an
 * "agent" in its own session that it deliberately never stops, the way a
 * crashed Studio would leave a terminal session behind.
 */
function stubMate(studio: string, agent = RUNS_UNTIL_SIGNALLED): void {
  writeExecutable(
    "agent",
    `#!/usr/bin/env bash
LOG="${LOG}"
note() { echo "$1 $2" >> "$LOG"; }
set -- agent
note agent started
${agent}
`,
  );
  writeExecutable(
    "mate",
    `#!/usr/bin/env bash
LOG="${LOG}"
note() { echo "$1 $2" >> "$LOG"; }
case "$1" in
  studio)
    note studio started
    setsid agent &
    set -- studio
    ${studio} ;;
esac
`,
  );
}

interface Outcome {
  status: number;
  stderr: string;
  log: string;
}

async function runSupervisor(signal?: { name: string }): Promise<Outcome> {
  const runtime = RUNTIME!;
  const containerName = `mate-supervisor-${Math.random().toString(36).slice(2, 10)}`;

  const child = spawn(
    runtime,
    [
      "run",
      "--rm",
      "--name",
      containerName,
      "--volume",
      `${root}:${CASE}:z`,
      "--network",
      "none",
      "--env",
      `HOME=${HOME}`,
      "--env",
      `PATH=${CASE}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      "--env",
      `MATE_STARTUP_SCRIPT=${CASE}/startup.ts`,
      // These cases run as the test image's root; this keeps them on the
      // unprivileged path the factory supervisor would otherwise take over.
      "--env",
      "MATE_FACTORY_ACTIVE=1",
      "--entrypoint",
      "bash",
      TEST_BASE_IMAGE,
      `${CASE}/entrypoint.sh`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.resume();

  if (signal) {
    /**
     * Waits for Studio and its agent to have installed their traps: a signal
     * before that tests the shell's default disposition, not this script.
     * Generous, because container starts are slow under a concurrent suite.
     */
    void (async () => {
      const logFile = path.join(root, "processes.log");
      const bothReady = () =>
        fs.existsSync(logFile) &&
        (fs.readFileSync(logFile, "utf8").match(/ ready/g) ?? []).length === 2;
      const deadline = Date.now() + 120_000;
      while (!(stderr.includes("studio on") && bothReady()) && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      spawnSync(runtime, ["kill", "--signal", signal.name, containerName], { stdio: "ignore" });
    })();
  }

  const status = await new Promise<number>((resolve) => {
    child.on("close", (code, closedBy) =>
      resolve(code ?? (closedBy ? 128 + (os.constants.signals[closedBy] ?? 0) : 1)),
    );
  });

  const logFile = path.join(root, "processes.log");
  return {
    status,
    stderr,
    log: fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "",
  };
}

const CASE_TIMEOUT = 60_000;

withContainer("a termination signal stops Studio and every agent session", () => {
  test(
    "SIGTERM stops Studio and a detached agent, and the container exits zero",
    async () => {
      stubStartup();
      stubMate(RUNS_UNTIL_SIGNALLED);

      const outcome = await runSupervisor({ name: "TERM" });

      expect(outcome.log).toContain("studio stopped");
      expect(outcome.log).toContain("agent stopped");
      expect(outcome.status).toBe(0);
    },
    CASE_TIMEOUT,
  );

  test(
    "SIGINT stops Studio and the container exits zero",
    async () => {
      stubStartup();
      stubMate(RUNS_UNTIL_SIGNALLED);

      const outcome = await runSupervisor({ name: "INT" });

      expect(outcome.log).toContain("studio stopped");
      expect(outcome.status).toBe(0);
    },
    CASE_TIMEOUT,
  );
});

withContainer("Studio's own outcome decides the status", () => {
  test(
    "Studio exiting non-zero is reported, after the session it left is stopped",
    async () => {
      stubStartup();
      stubMate(endsWith(5));

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(5);
      expect(outcome.stderr).toContain("studio ended with status 5");
      expect(outcome.log).toContain("agent stopped");
    },
    CASE_TIMEOUT,
  );

  test(
    "an agent session ending keeps Studio and the container running",
    async () => {
      stubStartup();
      stubMate(RUNS_UNTIL_SIGNALLED, `note agent ready; sleep 0.2; note agent stopped; exit 9`);

      const outcome = await runSupervisor({ name: "TERM" });

      expect(outcome.log.indexOf("agent stopped")).toBeLessThan(
        outcome.log.indexOf("studio stopped"),
      );
      expect(outcome.status).toBe(0);
    },
    CASE_TIMEOUT,
  );
});

withContainer("a stop the container caused is told apart from one it did not", () => {
  test(
    "a signal the container did not send is reported as it was",
    async () => {
      stubStartup();
      stubMate(endsWith(143));

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(143);
    },
    CASE_TIMEOUT,
  );

  test(
    "an OOM kill is not reported as a clean shutdown",
    async () => {
      stubStartup();
      stubMate(endsWith(137));

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(137);
    },
    CASE_TIMEOUT,
  );
});

withContainer("a startup that cannot reach Studio leaves nothing running", () => {
  test(
    "a failing startup program stops the container before Studio starts",
    async () => {
      writeExecutable(
        "bun",
        `#!/usr/bin/env bash\necho "mate-appliance: no companion to serve" >&2\nexit 1\n`,
      );
      stubMate(RUNS_UNTIL_SIGNALLED);

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(1);
      expect(outcome.stderr).toContain("no companion to serve");
      expect(outcome.log).toBe("");
    },
    CASE_TIMEOUT,
  );
});

/** Records what `mate` was started with, then exits. */
function recordingMate(): void {
  writeExecutable(
    "mate",
    `#!/usr/bin/env bash
{ echo "$1 argv: $*"
  echo "$1 cwd: $PWD"
  echo "$1 companion: \${MATE_ARTIFACT_PATH:-}"
  echo "$1 policy: \${MATE_UPDATE_POLICY:-}"
  echo "$1 audience: \${MATE_AUDIENCE-<unset>}"
  echo "$1 credential: \${STUB_CREDENTIAL:-}"; } >> "${CASE}/argv.log"
sleep 0.3
exit 0
`,
  );
}

withContainer("what the supervisor starts Studio with", () => {
  test(
    "Studio gets its port, host, write path, terminal, launch companion, and the policy",
    async () => {
      stubStartup();
      recordingMate();

      await runSupervisor();
      const recorded = fs.readFileSync(path.join(root, "argv.log"), "utf8");

      expect(recorded).toContain(
        `studio argv: studio serve --port 4097 --host 0.0.0.0 --writable --terminal --detach-timeout 30 --companion ${COMPANION} --no-git\n`,
      );
      expect(recorded).toContain(`studio companion: ${COMPANION}`);
      expect(recorded).toContain(`studio cwd: ${COMPANION}`);
      expect(recorded).toContain("studio policy: pinned");
      /** Credentials reach Studio, whose agent sessions inherit them. */
      expect(recorded).toContain("studio credential: secret");
      expect(recorded).not.toContain("opencode");
    },
    CASE_TIMEOUT,
  );

  test(
    "the planned audience reaches Studio's environment even when only the file selected it",
    async () => {
      stubStartup({ audience: "ba" });
      recordingMate();

      await runSupervisor();

      expect(fs.readFileSync(path.join(root, "argv.log"), "utf8")).toContain(
        "studio audience: ba\n",
      );
    },
    CASE_TIMEOUT,
  );

  test(
    "with no planned audience Studio's environment carries none",
    async () => {
      stubStartup();
      recordingMate();

      await runSupervisor();

      expect(fs.readFileSync(path.join(root, "argv.log"), "utf8")).toContain(
        "studio audience: <unset>\n",
      );
    },
    CASE_TIMEOUT,
  );

  test(
    "without the write path Studio gets neither --writable nor the terminal",
    async () => {
      stubStartup({ writable: false });
      recordingMate();

      await runSupervisor();

      expect(fs.readFileSync(path.join(root, "argv.log"), "utf8")).toContain(
        "studio argv: studio serve --port 4097 --host 0.0.0.0\n",
      );
    },
    CASE_TIMEOUT,
  );

  test(
    "Git synchronization drops --no-git; proxy settings are passed through",
    async () => {
      stubStartup({
        gitSync: true,
        allowedHosts: "studio.acme.test",
        publicOrigin: "https://studio.acme.test",
      });
      recordingMate();

      await runSupervisor();

      expect(fs.readFileSync(path.join(root, "argv.log"), "utf8")).toContain(
        `--companion ${COMPANION} --allowed-host studio.acme.test --public-origin https://studio.acme.test\n`,
      );
    },
    CASE_TIMEOUT,
  );
});

withContainer("the persistent home is reconciled at every start", () => {
  const LOGIN_FILES = {
    ".claude.json": "claude-login",
    ".claude/.credentials.json": "claude-credentials",
    ".local/share/opencode/auth.json": "opencode-login",
  };

  function seedLogins(): void {
    for (const [relative, content] of Object.entries(LOGIN_FILES)) {
      fs.mkdirSync(path.dirname(homeFile(relative)), { recursive: true });
      fs.writeFileSync(homeFile(relative), content);
    }
  }

  test(
    "a stale seed is refreshed and login and session files are untouched",
    async () => {
      stubStartup();
      recordingMate();
      seedLogins();
      fs.mkdirSync(homeFile(".claude/rules"), { recursive: true });
      fs.writeFileSync(homeFile(".claude/rules/tokensave.md"), "stale");

      await runSupervisor();

      expect(fs.readFileSync(homeFile(".claude/rules/tokensave.md"), "utf8")).toBe("current\n");
      for (const [relative, content] of Object.entries(LOGIN_FILES)) {
        expect(fs.readFileSync(homeFile(relative), "utf8")).toBe(content);
      }
      expect(fs.readFileSync(path.join(root, "tokensave.log"), "utf8")).toBe(
        "install --agent claude --git-hook no --wildcard-permissions\ninstall --agent opencode --git-hook no --wildcard-permissions\n",
      );
    },
    CASE_TIMEOUT,
  );

  test(
    "a missing agent home is recreated before anything is served",
    async () => {
      stubStartup();
      recordingMate();

      await runSupervisor();

      expect(fs.existsSync(homeFile(".claude"))).toBe(true);
      expect(fs.readFileSync(homeFile(".config/opencode/tokensave.md"), "utf8")).toBe("current\n");
      expect(fs.existsSync(path.join(root, "argv.log"))).toBe(true);
    },
    CASE_TIMEOUT,
  );

  test(
    "a failing integration names the agent and stops before Studio",
    async () => {
      stubStartup();
      recordingMate();
      fs.writeFileSync(path.join(root, "tokensave-fails"), "opencode");

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(1);
      expect(outcome.stderr).toContain("TokenSave integration for opencode");
      expect(fs.existsSync(path.join(root, "argv.log"))).toBe(false);
    },
    CASE_TIMEOUT,
  );

  test(
    "leftover generated registry config is removed and login files are not",
    async () => {
      stubStartup();
      recordingMate();
      seedLogins();
      fs.writeFileSync(homeFile(".mate-setup-npmrc.AbC123"), "//acme.test:_authToken=${TOKEN}");
      fs.writeFileSync(homeFile(".mate-setup-npmrc.xYz987"), "stale");

      await runSupervisor();

      expect(fs.existsSync(homeFile(".mate-setup-npmrc.AbC123"))).toBe(false);
      expect(fs.existsSync(homeFile(".mate-setup-npmrc.xYz987"))).toBe(false);
      for (const relative of Object.keys(LOGIN_FILES)) {
        expect(fs.existsSync(homeFile(relative))).toBe(true);
      }
    },
    CASE_TIMEOUT,
  );

  test(
    "reconciliation starts no package manager and needs no network",
    async () => {
      stubStartup();
      recordingMate();

      const outcome = await runSupervisor();

      expect(outcome.stderr).not.toContain("TokenSave integration");
      expect(fs.existsSync(path.join(root, "installers.log"))).toBe(false);
      expect(fs.existsSync(path.join(root, "argv.log"))).toBe(true);
    },
    CASE_TIMEOUT,
  );
});

describe("the supervisor script itself", () => {
  test("reconciles the home before credentials and the startup plan", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const cleanupAt = source.indexOf(".mate-setup-npmrc.*");
    const installAt = source.indexOf('"$TOKENSAVE" install');
    const credentialsAt = source.indexOf('"$BUN" "$STARTUP_SCRIPT" --credentials');
    expect(cleanupAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(cleanupAt);
    expect(credentialsAt).toBeGreaterThan(installAt);
  });

  test("is valid bash", () => {
    const result = spawnSync("bash", ["-n", ENTRYPOINT], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  test("declares the pinned update policy before any Mate invocation", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const policyAt = source.indexOf("export MATE_UPDATE_POLICY=pinned");
    const firstMateAt = source.indexOf('"$MATE"');
    const firstStartupAt = source.indexOf('"$BUN" "$STARTUP_SCRIPT"');
    expect(policyAt).toBeGreaterThan(-1);
    expect(policyAt).toBeLessThan(firstStartupAt);
    expect(policyAt).toBeLessThan(firstMateAt);
  });

  test("exports the planned audience before Studio starts and unsets it otherwise", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const planAt = source.indexOf('eval "$PLAN"');
    const exportAt = source.indexOf('export MATE_AUDIENCE="$MATE_PLAN_AUDIENCE"');
    const unsetAt = source.indexOf("unset MATE_AUDIENCE");
    const studioAt = source.indexOf('"$MATE" "${STUDIO_ARGS[@]}"');
    expect(exportAt).toBeGreaterThan(planAt);
    expect(unsetAt).toBeGreaterThan(planAt);
    expect(exportAt).toBeLessThan(studioAt);
    expect(unsetAt).toBeLessThan(studioAt);
  });

  test("exports credentials before the startup plan runs Mate", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const credentialsAt = source.indexOf('"$BUN" "$STARTUP_SCRIPT" --credentials');
    const evalAt = source.indexOf('eval "$CREDENTIALS"');
    const planAt = source.indexOf('PLAN="$("$BUN" "$STARTUP_SCRIPT")"');
    expect(credentialsAt).toBeGreaterThan(-1);
    expect(evalAt).toBeGreaterThan(credentialsAt);
    expect(planAt).toBeGreaterThan(evalAt);
  });

  test("clears the startup-only tokens after the plan and before Studio starts", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const planAt = source.indexOf('PLAN="$("$BUN" "$STARTUP_SCRIPT")"');
    const unsetAt = source.indexOf("unset MATE_PLUGIN_REGISTRY_TOKEN MATE_GIT_CLONE_TOKEN");
    const studioAt = source.indexOf('"$MATE" "${STUDIO_ARGS[@]}"');
    expect(unsetAt).toBeGreaterThan(planAt);
    expect(unsetAt).toBeLessThan(studioAt);
  });

  test("refuses a bash too old for the wait it relies on", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(source).toContain("BASH_VERSINFO");
    expect(source).toContain("wait -n -p");
  });
});
