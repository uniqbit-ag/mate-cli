/** @test-requires containers */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findContainerRuntime, TEST_BASE_IMAGE } from "./container-runtime";
import { CONTAINER_ROOT } from "./image-inputs";

/**
 * Factory mode's root supervisor, run as the shell script the image runs.
 *
 * Sysbox, the inner daemon, `docker`, the broker (`mate`) and the startup
 * program are stubs that record what they were asked and as whom, so each case
 * reads back the order things started and stopped in, which identity Studio's
 * side ran as, and where the credential went. `setpriv` is the real one.
 */

const SUPERVISOR = path.join(CONTAINER_ROOT, "scripts", "factory-supervisor.sh");
const RUNTIME = findContainerRuntime();
const withContainer = RUNTIME === null ? describe.skip : describe;

const CASE = "/case";
const LOG = `${CASE}/order.log`;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-factory-supervisor-"));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.copyFileSync(SUPERVISOR, path.join(root, "supervisor.sh"));
});

afterEach(() => {
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
        `${CASE}/run`,
        `${CASE}/state`,
      ],
      { stdio: "ignore" },
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(name: string, body: string): void {
  const file = path.join(root, "bin", name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\nnote() { echo "$*" >> "${LOG}"; }\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/** Runs until TERM, noting start and stop; `ready` names a file to create once started. */
const longRunning = (name: string, ready = "") => `
note "${name} started uid=$(id -u) home=$HOME token=\${CLAUDE_CODE_OAUTH_TOKEN:-none}"
${ready ? `touch "${ready}"` : ""}
trap 'note "${name} stopped"; exit 0' TERM
while :; do sleep 0.05 & wait $!; done
`;

interface Options {
  factory?: boolean;
  preflightFails?: boolean;
  dockerdFails?: boolean;
}

function stubs(options: Options = {}): void {
  const factory = options.factory ?? true;
  writeExecutable(
    "bun",
    `case "$2" in
  --factory)
    ${factory ? "" : 'echo "mate-appliance: the container runs as root without factory mode" >&2; exit 1'}
    printf '%s\\n' MATE_FACTORY_ENABLED=1 "MATE_FACTORY_CREDENTIAL_NAME='CLAUDE_CODE_OAUTH_TOKEN'" "MATE_FACTORY_CREDENTIAL_VALUE='acme-token'" ;;
  --factory-preflight)
    ${options.preflightFails ? 'echo "mate-appliance: factory mode needs the container is privileged" >&2; exit 1' : "exit 0"} ;;
  --factory-config)
    echo "studioPort: 4097" > "$3" ;;
esac`,
  );
  writeExecutable("sysbox-mgr", longRunning("sysbox-mgr", `${CASE}/run/sysbox/sysmgr.sock`));
  writeExecutable("sysbox-fs", longRunning("sysbox-fs", `${CASE}/run/sysbox/sysfs.sock`));
  writeExecutable(
    "dockerd",
    options.dockerdFails
      ? 'note "dockerd started"; sleep 0.3; note "dockerd exited"; exit 1'
      : longRunning("dockerd", `${CASE}/run/mate-factory/docker.sock`),
  );
  writeExecutable(
    "docker",
    `case "$1" in
  info)
    test -e "${CASE}/run/mate-factory/docker.sock" || exit 1
    if [[ "$*" == *Runtimes* ]]; then echo '{"runc":{},"sysbox-runc":{}}'; fi ;;
  image)
    case "$2" in
      ls) printf '%s\n' mate-workset:0.9.0-acme mate-workset:1.0.0-acme mate-workset:0.8.0-acme ;;
      rm) note "docker image rm $3"; [[ "$3" != mate-workset:0.8.0-acme ]] ;;
      *) exit 1 ;;
    esac ;;
  import) note "docker import $*" ;;
  ps) echo workset-acme ;;
  stop) note "docker $*" ;;
esac`,
  );
  writeExecutable(
    "mate",
    longRunning(
      "broker",
      `${CASE}/run/mate-factory/broker.sock" "${CASE}/run/mate-factory/attach.sock`,
    ).replace('note "broker started', 'note "broker $* started'),
  );
  writeExecutable(
    "appliance",
    `readable=no; [[ -r "$MATE_APPLIANCE_CONFIG" ]] && readable=yes
note "studio started uid=$(id -u) home=$HOME token=\${CLAUDE_CODE_OAUTH_TOKEN:-none} docker=\${DOCKER_HOST:-none} active=$MATE_FACTORY_ACTIVE broker=$MATE_FACTORY_BROKER config=$MATE_APPLIANCE_CONFIG config-readable=$readable"
trap 'note "studio stopped"; exit 0' TERM
while :; do sleep 0.05 & wait $!; done`,
  );
  // The test image has no procps; nothing of mate's is left once Studio stops.
  writeExecutable("pkill", "exit 1");
  writeExecutable("pgrep", "exit 1");
}

async function runSupervisor(
  stopWhenReady: boolean,
): Promise<{ status: number; stderr: string; log: string }> {
  const runtime = RUNTIME!;
  const name = `mate-factory-supervisor-${Math.random().toString(36).slice(2, 10)}`;
  const env = {
    PATH: `${CASE}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    MATE_VERSION: "1.0.0-acme",
    // As in the image: HOME names mate's home even while the supervisor is root.
    HOME: "/home/mate",
    CLAUDE_CODE_OAUTH_TOKEN: "acme-token",
    MATE_APPLIANCE_ENTRYPOINT: `${CASE}/bin/appliance`,
    MATE_FACTORY_RUN_DIR: `${CASE}/run/mate-factory`,
    MATE_SYSBOX_RUN_DIR: `${CASE}/run/sysbox`,
    MATE_FACTORY_STATE_DIR: `${CASE}/state`,
    MATE_CGROUP_ROOT: `${CASE}/no-cgroup`,
    MATE_WORKSET_ARCHIVE: `${CASE}/workset-rootfs.tar`,
    MATE_WORKSET_CONF: `${CASE}/workset-image.conf`,
    MATE_FACTORY_DAEMON_CONFIG: `${CASE}/daemon.json`,
    MATE_FACTORY_READY_SECONDS: "10",
  };
  fs.writeFileSync(
    path.join(root, "workset-image.conf"),
    'ENV MATE_UPDATE_POLICY=pinned\nCMD ["/usr/local/bin/mate-workset-init"]\n',
  );
  const child = spawn(
    runtime,
    [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--volume",
      `${root}:${CASE}:z`,
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--entrypoint",
      "bash",
      TEST_BASE_IMAGE,
      "-c",
      `useradd --uid 10001 --create-home mate && exec bash ${CASE}/supervisor.sh`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.resume();

  if (stopWhenReady) {
    void (async () => {
      const logFile = path.join(root, "order.log");
      const deadline = Date.now() + 120_000;
      while (
        !(fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("studio started")) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(50);
      }
      spawnSync(runtime, ["kill", "--signal", "TERM", name], { stdio: "ignore" });
    })();
  }

  const status = await new Promise<number>((resolve) =>
    child.on("close", (code) => resolve(code ?? 1)),
  );
  const logFile = path.join(root, "order.log");
  return { status, stderr, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "" };
}

const order = (log: string) =>
  log
    .trim()
    .split("\n")
    .map((line) => line.split(" ").slice(0, 2).join(" "));

withContainer("the factory supervisor", () => {
  test("starts Sysbox, the inner daemon and the broker before Studio, and stops them after it", async () => {
    stubs();
    const outcome = await runSupervisor(true);
    expect(outcome.status).toBe(0);
    expect(order(outcome.log)).toEqual([
      "sysbox-mgr started",
      "sysbox-fs started",
      "dockerd started",
      "docker import",
      "docker image",
      "docker image",
      "broker factory",
      "studio started",
      "studio stopped",
      "docker stop",
      "broker stopped",
      "dockerd stopped",
      "sysbox-fs stopped",
      "sysbox-mgr stopped",
    ]);
    expect(outcome.log).toContain("--change ENV MATE_UPDATE_POLICY=pinned");
    expect(outcome.log).toContain("mate-workset:1.0.0-acme");
    expect(outcome.log).toContain("docker stop --time 10 workset-acme");
    // Unused older images go; the current one is never offered for removal.
    expect(outcome.log).toContain("docker image rm mate-workset:0.9.0-acme");
    expect(outcome.log).not.toContain("docker image rm mate-workset:1.0.0-acme");
    expect(outcome.stderr).toContain("removed the unused Workset image mate-workset:0.9.0-acme");
    expect(outcome.stderr).not.toContain(
      "removed the unused Workset image mate-workset:0.8.0-acme",
    );
  }, 180_000);

  test("hands the credential to the broker only, and starts Studio as mate without it", async () => {
    stubs();
    const outcome = await runSupervisor(true);
    const line = (name: string) =>
      outcome.log.split("\n").find((entry) => entry.startsWith(name)) ?? "";

    expect(line("broker")).toContain("uid=0 home=/root token=acme-token");
    expect(line("studio started")).toContain(
      "uid=10001 home=/home/mate token=none docker=none active=1",
    );
    expect(line("studio started")).toContain(`broker=${CASE}/run/mate-factory/broker.sock`);
    expect(line("studio started")).toContain(`config=${CASE}/run/mate-factory/appliance.yaml`);
    expect(line("studio started")).toContain("config-readable=yes");
    for (const name of ["sysbox-mgr", "sysbox-fs", "dockerd"]) {
      expect(line(`${name} started`)).toContain("token=none");
    }
  }, 180_000);

  test("root without factory mode starts nothing", async () => {
    stubs({ factory: false });
    const outcome = await runSupervisor(false);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("without factory mode");
    expect(outcome.log).toBe("");
  }, 180_000);

  test("a failed preflight starts nothing", async () => {
    stubs({ preflightFails: true });
    const outcome = await runSupervisor(false);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("privileged");
    expect(outcome.log).toBe("");
  }, 180_000);

  test("an inner daemon that does not come up stops startup before Studio", async () => {
    stubs({ dockerdFails: true });
    const outcome = await runSupervisor(false);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("the inner Docker daemon exited before it became ready");
    expect(outcome.log).not.toContain("studio started");
    expect(outcome.log).toContain("sysbox-mgr stopped");
  }, 180_000);
});
