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
function stubStartup(
  options: {
    writable?: boolean;
    gitSync?: boolean;
    allowedHosts?: string;
    publicOrigin?: string;
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
