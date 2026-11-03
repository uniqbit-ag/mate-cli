/** @test-requires containers, network */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findContainerRuntime, TEST_BASE_IMAGE } from "./container-runtime";
import { CONTAINER_ROOT, readImageInputs } from "./image-inputs";

/**
 * A Workset container's init, socket proxy and prune, run as the scripts the
 * Workset image installs, with the pinned `socat`.
 *
 * `dockerd` is a stub that answers `pong` on the socket it is given, after a
 * short start-up, and notes when it starts and stops; `docker` is a stub
 * whose `version` asks that socket and whose `system prune` is noted.
 */

const RUNTIME = findContainerRuntime();
const withContainer = RUNTIME === null ? describe.skip : describe;
const SOCAT_VERSION = readImageInputs().factory.os_packages.socat!;
const IMAGE = `mate-workset-init-case:${Math.random().toString(36).slice(2, 8)}`;
const CASE = "/case";
const LOG = `${CASE}/order.log`;

const DOCKERD = `#!/bin/bash
# Named dockerd in the process table, as the real one.
note() { echo "$*" >> "${LOG}"; }
host="\${2#unix://}"
if [[ -s /var/run/docker.pid ]] && kill -0 "$(cat /var/run/docker.pid)" 2>/dev/null; then
  note "dockerd refused"; exit 1
fi
echo $$ > /var/run/docker.pid
note "dockerd started"
sleep 0.5
socat "UNIX-LISTEN:$host,fork,unlink-early" SYSTEM:'echo pong' &
listener=$!
trap 'kill $listener; note "dockerd stopped"; rm -f /var/run/docker.pid; exit 0' TERM
while :; do sleep 0.05 & wait $!; done
`;

const DOCKER = `#!/bin/bash
note() { echo "$*" >> "${LOG}"; }
case "$1" in
  version) [[ "$(socat -t 2 - "UNIX-CONNECT:\${DOCKER_HOST#unix://}" </dev/null 2>/dev/null)" == pong ]] ;;
  system) note "docker system $2 $3" ;;
  *) exit 1 ;;
esac
`;

let context: string;
let root: string;
let container: string;

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(RUNTIME!, args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function exec(command: string, user = "root") {
  return run(["exec", "--user", user, container, "bash", "-c", command]);
}

const log = () => {
  const file = path.join(root, "order.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};
const count = (entry: string) =>
  log()
    .split("\n")
    .filter((line) => line === entry).length;

/** The client a Workset command is: one connection to the public socket. */
const CONNECT = "socat -t 5 - UNIX-CONNECT:/var/run/docker.sock </dev/null";

async function startInit(): Promise<void> {
  container = `mate-workset-init-${Math.random().toString(36).slice(2, 10)}`;
  const started = run([
    "run",
    "--detach",
    "--name",
    container,
    "--network",
    "none",
    "--volume",
    `${root}:${CASE}:z`,
    IMAGE,
  ]);
  expect(started.stderr).toBe("");
  const deadline = Date.now() + 10_000;
  while (exec("test -S /var/run/docker.sock").status !== 0 && Date.now() < deadline) {
    await Bun.sleep(50);
  }
}

withContainer("the Workset init", () => {
  beforeAll(() => {
    context = fs.mkdtempSync(path.join(os.tmpdir(), "mate-workset-init-image-"));
    for (const [script, name] of [
      ["workset-init.sh", "mate-workset-init"],
      ["workset-docker-proxy.sh", "mate-workset-docker-proxy"],
      ["workset-prune.sh", "mate-workset-prune"],
    ]) {
      fs.copyFileSync(path.join(CONTAINER_ROOT, "scripts", script!), path.join(context, name!));
    }
    fs.writeFileSync(path.join(context, "dockerd"), DOCKERD);
    fs.writeFileSync(path.join(context, "docker"), DOCKER);
    fs.writeFileSync(
      path.join(context, "Dockerfile"),
      `FROM ${TEST_BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends "socat=${SOCAT_VERSION}" \\
 && rm -rf /var/lib/apt/lists/* \\
 && groupadd docker && useradd --uid 10001 --groups docker mate
COPY mate-workset-init mate-workset-docker-proxy mate-workset-prune dockerd docker /usr/local/bin/
RUN chmod +x /usr/local/bin/*
CMD ["/usr/local/bin/mate-workset-init"]
`,
    );
    const built = run([
      "build",
      ...(RUNTIME === "podman" ? ["--format", "docker"] : []),
      "--tag",
      IMAGE,
      context,
    ]);
    if (built.status !== 0) throw new Error(built.stderr);
  }, 600_000);

  afterAll(() => {
    run(["image", "rm", "--force", IMAGE]);
    fs.rmSync(context, { recursive: true, force: true });
  });

  afterEach(() => {
    run(["rm", "--force", container]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const fresh = () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-workset-init-"));
    fs.chmodSync(root, 0o777);
  };

  test("starts no daemon, only the socket listener", async () => {
    fresh();
    await startInit();
    await Bun.sleep(500);
    expect(log()).toBe("");
    expect(exec("stat -c '%U:%G %a' /var/run/docker.sock").stdout.trim()).toBe("root:docker 660");
  }, 120_000);

  test("the first connection starts the daemon and is answered by it", async () => {
    fresh();
    await startInit();
    const first = exec(CONNECT, "mate");
    expect(first.stdout.trim()).toBe("pong");
    expect(count("dockerd started")).toBe(1);
    // Later connections reach the same daemon.
    expect(exec(CONNECT, "mate").stdout.trim()).toBe("pong");
    expect(count("dockerd started")).toBe(1);
  }, 120_000);

  test("two concurrent first connections start one daemon", async () => {
    fresh();
    await startInit();
    const both = exec(`(${CONNECT}) & (${CONNECT}) & wait`, "mate");
    expect(both.stdout.trim().split("\n")).toEqual(["pong", "pong"]);
    expect(count("dockerd started")).toBe(1);
    expect(log()).not.toContain("dockerd refused");
  }, 120_000);

  test("prune does nothing while the daemon is down, and prunes once it runs", async () => {
    fresh();
    await startInit();
    expect(exec("mate-workset-prune").status).toBe(0);
    expect(log()).toBe("");

    exec(CONNECT);
    expect(exec("mate-workset-prune").status).toBe(0);
    expect(log()).toContain("docker system prune --force");
    expect(count("dockerd started")).toBe(1);
  }, 120_000);

  test("TERM stops the listener, then the daemon", async () => {
    fresh();
    await startInit();
    exec(CONNECT);
    const stopped = run(["stop", "--time", "10", container]);
    expect(stopped.status).toBe(0);
    expect(log()).toContain("dockerd stopped");
    const exit = run(["inspect", "--format", "{{.State.ExitCode}}", container]);
    expect(exit.stdout.trim()).toBe("0");
  }, 120_000);

  test("TERM without a daemon stops the listener alone", async () => {
    fresh();
    await startInit();
    expect(run(["stop", "--time", "10", container]).status).toBe(0);
    expect(run(["inspect", "--format", "{{.State.ExitCode}}", container]).stdout.trim()).toBe("0");
    expect(log()).toBe("");
  }, 120_000);
});
