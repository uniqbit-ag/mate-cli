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
  fs.copyFileSync(ENTRYPOINT, path.join(root, "entrypoint.sh"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(name: string, body: string): void {
  const file = path.join(root, "bin", name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

/**
 * Stands in for the startup program: prints the plan the supervisor evaluates,
 * so these cases are about the supervisor rather than about discovery.
 */
function stubStartup(writable = true): void {
  writeExecutable(
    "bun",
    `#!/usr/bin/env bash
if [[ "\${2:-}" == "--credentials" ]]; then
  echo "export STUB_CREDENTIAL='secret'"
  exit 0
fi
cat <<'EOF'
MATE_PLAN_COMPANION='${COMPANION}'
MATE_PLAN_AGENT_PORT='4096'
MATE_PLAN_AGENT_HOST='0.0.0.0'
MATE_PLAN_STUDIO_PORT='4097'
MATE_PLAN_STUDIO_HOST='0.0.0.0'
MATE_PLAN_STUDIO_WRITABLE='${writable ? "1" : ""}'
MATE_PLAN_GIT_SYNC=''
EOF
`,
  );
}

/**
 * A `mate` whose two subcommands behave as each case needs. Each records that
 * it started and that it stopped, so a case can assert that neither process
 * was left running.
 */
function stubMate(studio: string, agent: string): void {
  writeExecutable(
    "mate",
    `#!/usr/bin/env bash
LOG="${LOG}"
note() { echo "$1 $2" >> "$LOG"; }
case "$1" in
  studio) note studio started; ${studio} ;;
  opencode) note agent started; ${agent} ;;
esac
`,
  );
}

/** Runs until signalled, then reports the signal the way a real child would. */
const RUNS_UNTIL_SIGNALLED = `
trap 'note "$1" stopped; exit 143' TERM
trap 'note "$1" stopped; exit 130' INT
while :; do sleep 0.05 & wait $!; done
`;

/** Ends on its own with a given status. */
const endsWith = (status: number) => `sleep 0.4; note "$1" stopped; exit ${status}`;

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
      "--env",
      `PATH=${CASE}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      "--env",
      `MATE_STARTUP_SCRIPT=${CASE}/startup.ts`,
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
    // Wait for the supervisor to say both processes are up rather than guessing
    // a delay: a signal that arrives before the traps are installed would be
    // testing the shell's default disposition, not this script.
    void (async () => {
      // Generous, because several of these cases run concurrently with the
      // rest of the suite and a container start is not instant under that
      // contention. Signalling early would test the shell's default signal
      // disposition rather than this script's traps.
      const deadline = Date.now() + 120_000;
      while (!stderr.includes("studio on") && Date.now() < deadline) {
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

/** Both processes started and both recorded that they stopped. */
function bothStopped(log: string): boolean {
  const started = (log.match(/ started/g) ?? []).length;
  const stopped = (log.match(/ stopped/g) ?? []).length;
  return started === 2 && stopped === 2;
}

const CASE_TIMEOUT = 60_000;

withContainer("a termination signal stops both processes", () => {
  test(
    "SIGTERM stops both, leaves nothing running, and the container exits zero",
    async () => {
      stubStartup();
      stubMate(RUNS_UNTIL_SIGNALLED, RUNS_UNTIL_SIGNALLED);

      const outcome = await runSupervisor({ name: "TERM" });

      expect(outcome.log).toContain("studio started");
      expect(outcome.log).toContain("agent started");
      expect(bothStopped(outcome.log)).toBe(true);
      expect(outcome.status).toBe(0);
    },
    CASE_TIMEOUT,
  );

  test(
    "SIGINT stops both and the container exits zero",
    async () => {
      stubStartup();
      stubMate(RUNS_UNTIL_SIGNALLED, RUNS_UNTIL_SIGNALLED);

      const outcome = await runSupervisor({ name: "INT" });

      expect(bothStopped(outcome.log)).toBe(true);
      expect(outcome.status).toBe(0);
    },
    CASE_TIMEOUT,
  );
});

withContainer("the first process to end on its own decides the status", () => {
  test(
    "the session exiting non-zero is what the container reports",
    async () => {
      stubStartup();
      stubMate(RUNS_UNTIL_SIGNALLED, endsWith(7));

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(7);
      expect(outcome.stderr).toContain("session ended with status 7");
      expect(bothStopped(outcome.log)).toBe(true);
    },
    CASE_TIMEOUT,
  );

  test(
    "Studio exiting non-zero is reported as Studio's status, not the session's",
    async () => {
      stubStartup();
      // The session is then stopped as cleanup and reports 143; that must not
      // replace Studio's own status.
      stubMate(endsWith(5), RUNS_UNTIL_SIGNALLED);

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(5);
      expect(outcome.stderr).toContain("studio ended with status 5");
      expect(bothStopped(outcome.log)).toBe(true);
    },
    CASE_TIMEOUT,
  );

  test(
    "a dead session is not survived by Studio",
    async () => {
      stubStartup();
      stubMate(RUNS_UNTIL_SIGNALLED, endsWith(0));

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(0);
      expect(bothStopped(outcome.log)).toBe(true);
    },
    CASE_TIMEOUT,
  );
});

withContainer("a stop the container caused is told apart from one it did not", () => {
  test(
    "a signal the container did not send is reported as it was",
    async () => {
      stubStartup();
      // Nothing terminated this container; the session simply reports 143.
      stubMate(RUNS_UNTIL_SIGNALLED, endsWith(143));

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(143);
    },
    CASE_TIMEOUT,
  );

  test(
    "an OOM kill is not reported as a clean shutdown",
    async () => {
      stubStartup();
      stubMate(RUNS_UNTIL_SIGNALLED, endsWith(137));

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(137);
    },
    CASE_TIMEOUT,
  );
});

withContainer("a startup that cannot complete leaves nothing running", () => {
  test(
    "a failing startup program stops the container before either process starts",
    async () => {
      writeExecutable(
        "bun",
        `#!/usr/bin/env bash\necho "mate-appliance: no companion to serve" >&2\nexit 1\n`,
      );
      stubMate(RUNS_UNTIL_SIGNALLED, RUNS_UNTIL_SIGNALLED);

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(1);
      expect(outcome.stderr).toContain("no companion to serve");
      expect(outcome.log).toBe("");
    },
    CASE_TIMEOUT,
  );

  test(
    "a launch preflight refusal is passed through with its guidance and status",
    async () => {
      stubStartup();
      // A refusal reaches the supervisor as a non-zero status, not as output
      // the supervisor has to interpret.
      stubMate(
        RUNS_UNTIL_SIGNALLED,
        `echo "mate: the openspec capability is not installed; run \\\`mate install\\\`" >&2
note "$1" stopped
exit 3`,
      );

      const outcome = await runSupervisor();

      expect(outcome.status).toBe(3);
      expect(outcome.stderr).toContain("the openspec capability is not installed");
      expect(outcome.stderr).toContain("mate install");
    },
    CASE_TIMEOUT,
  );
});

withContainer("what the supervisor starts the two processes with", () => {
  test(
    "Studio gets its port, host and writability; the session gets the companion and the policy",
    async () => {
      stubStartup();
      writeExecutable(
        "mate",
        `#!/usr/bin/env bash
LOG="${LOG}"
note() { echo "$1 $2" >> "$LOG"; }
{ echo "$1 argv: $*"
  echo "$1 cwd: $PWD"
  echo "$1 companion: \${MATE_ARTIFACT_PATH:-}"
  echo "$1 policy: \${MATE_UPDATE_POLICY:-}"
  echo "$1 credential: \${STUB_CREDENTIAL:-}"; } >> "${CASE}/argv.log"
note "$1" started
sleep 0.4
note "$1" stopped
exit 0
`,
      );

      await runSupervisor();
      const recorded = fs.readFileSync(path.join(root, "argv.log"), "utf8");

      expect(recorded).toContain("studio argv: studio serve --port 4097 --host 0.0.0.0 --writable");
      expect(recorded).toContain(
        "opencode argv: opencode -- --companion --yes web --port 4096 --hostname 0.0.0.0",
      );
      // The companion is named to the session explicitly rather than inferred
      // from the directory the container happened to start in.
      expect(recorded).toContain(`opencode companion: ${COMPANION}`);
      expect(recorded).toContain(`opencode cwd: ${COMPANION}`);
      // The pinned policy reaches both serving processes.
      expect(recorded).toContain("studio policy: pinned");
      expect(recorded).toContain("opencode policy: pinned");
      // Credentials reach the session's environment.
      expect(recorded).toContain("opencode credential: secret");
    },
    CASE_TIMEOUT,
  );

  test(
    "Studio is started without --writable when it is not configured",
    async () => {
      stubStartup(false);
      writeExecutable(
        "mate",
        `#!/usr/bin/env bash\necho "$1 argv: $*" >> "${CASE}/argv.log"\nsleep 0.3\nexit 0\n`,
      );

      await runSupervisor();

      expect(fs.readFileSync(path.join(root, "argv.log"), "utf8")).toContain(
        "studio argv: studio serve --port 4097 --host 0.0.0.0\n",
      );
    },
    CASE_TIMEOUT,
  );
});

describe("the supervisor script itself", () => {
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

  test("refuses a bash too old for the wait it relies on", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(source).toContain("BASH_VERSINFO");
    expect(source).toContain("wait -n -p");
  });
});
