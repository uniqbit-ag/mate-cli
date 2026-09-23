#!/usr/bin/env bun
/**
 * Verifies a built appliance image before anything is published.
 *
 * The checks are the ones the image's claims rest on: it contains the release
 * it says it does, every supported tool is installed rather than merely
 * cached, the prebuilt workspace is complete and compatible, nothing an
 * operator supplies is baked in, and the container does not run as root.
 *
 * Package availability alone is not a passing check, so this also starts a
 * container against a fresh companion with *every* supported capability
 * enabled, with outbound networking disabled, and asserts both HTTP services
 * come up without a package manager running anywhere in the process tree.
 *
 *   bun scripts/verify-image.ts --image mate-appliance:local --mate-version 0.17.0-canary.3
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findContainerRuntime } from "../src/container-runtime";
import { readImageInputs, REQUIRED_TOOL_COMMANDS } from "../src/image-inputs";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function option(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

export interface ImageProbe {
  (
    args: string[],
    options?: { network?: boolean; volumes?: string[]; user?: string },
  ): {
    status: number;
    stdout: string;
    stderr: string;
  };
}

function probeFor(runtime: string, image: string): ImageProbe {
  return (args, options = {}) => {
    const result = spawnSync(
      runtime,
      [
        "run",
        "--rm",
        ...(options.network === false ? ["--network", "none"] : []),
        ...(options.user ? ["--user", options.user] : []),
        ...(options.volumes ?? []).flatMap((volume) => ["--volume", volume]),
        "--entrypoint",
        "bash",
        image,
        "-lc",
        args.join(" "),
      ],
      { encoding: "utf8" },
    );
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

/** A fresh companion with every supported capability and package manager enabled. */
export const FULLY_LOADED_COMPANION = `type: companion
git: auto
allowedAgents:
  - claude
  - opencode
packageManagers:
  - bun
  - uv
capabilities:
  - name: openspec
  - name: graphify
  - name: rtk
  - name: tokensave
  - name: react-doctor
  - name: context-mode
  - name: context7
`;

/**
 * Spawns the `context7` entry of an OpenCode config as OpenCode would and sends
 * MCP `initialize`; prints the reply and exits zero only if one arrives.
 */
export const MCP_ANSWERS = `
const { spawn } = require("node:child_process");
const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const [command, ...args] = config.mcp.context7.command;
const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
const timer = setTimeout(() => { child.kill(); process.exit(1); }, 30000);
let out = "";
child.stdout.on("data", (chunk) => {
  out += chunk;
  if (out.includes("\\n")) { clearTimeout(timer); process.stdout.write(out); child.kill(); process.exit(0); }
});
child.on("error", (error) => { console.error(String(error)); process.exit(1); });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } } }) + "\\n");
`;

export function makeFreshCompanion(root: string): string {
  const companion = path.join(root, "acme");
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(companion, ".mate", "config", "framework.yaml"),
    FULLY_LOADED_COMPANION,
  );
  fs.mkdirSync(path.join(companion, "docs"), { recursive: true });
  fs.writeFileSync(path.join(companion, "docs", "README.md"), "# Acme\n");
  // The entries `mate companion setup` commits for Context7, so the offline run
  // spawns the server exactly as a session would.
  fs.mkdirSync(path.join(companion, ".opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(companion, ".opencode", "opencode.json"),
    `${JSON.stringify({ mcp: { context7: { type: "local", command: ["context7-mcp"], enabled: true } } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(companion, ".mcp.json"),
    `${JSON.stringify({ mcpServers: { context7: { command: "context7-mcp", args: [] } } }, null, 2)}\n`,
  );
  // A freshly cloned companion has no machine-local workspace; that absence is
  // the point of the preparation the container performs.
  spawnSync("git", ["init", "-q", companion], { stdio: "ignore" });
  spawnSync("git", ["-C", companion, "add", "-A"], { stdio: "ignore" });
  spawnSync(
    "git",
    ["-C", companion, "-c", "user.email=a@b.c", "-c", "user.name=T", "commit", "-qm", "init"],
    { stdio: "ignore" },
  );
  // A clone has a remote. Offline, a session that synchronizes it anyway fails
  // its first launch, so this is what proves synchronization stays off unless
  // it was asked for.
  spawnSync(
    "git",
    ["-C", companion, "remote", "add", "origin", "https://git.example.invalid/acme.git"],
    { stdio: "ignore" },
  );
  return companion;
}

export function runChecks(
  probe: ImageProbe,
  expected: { mateVersion: string; opencodeVersion: string; uid: number; user: string },
): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // The contained version is the published one, readable from inside.
  const version = probe(["mate", "--version"], { network: false });
  const reported = version.stdout.trim().split("\n").pop() ?? "";
  add(
    "the image contains the version it claims",
    reported === expected.mateVersion,
    `mate --version reported "${reported}", expected "${expected.mateVersion}"`,
  );

  const opencode = probe(["opencode", "--version"], { network: false });
  add(
    "the agent command is present at the pinned version",
    opencode.stdout.trim() === expected.opencodeVersion,
    `opencode --version reported "${opencode.stdout.trim()}", expected "${expected.opencodeVersion}"`,
  );

  // Every runtime and tool a managed session needs, present without the
  // bootstrap having to obtain any of them.
  for (const command of ["node", "bun", "git", "ssh", ...REQUIRED_TOOL_COMMANDS]) {
    const found = probe([`command -v ${command}`], { network: false });
    add(
      `${command} resolves on PATH`,
      found.status === 0,
      found.stdout.trim() || found.stderr.trim(),
    );
  }

  // Git's TLS trust store is usable, which is what a clone needs.
  const trust = probe([
    "git ls-remote https://github.com/uniqbit-ag/mate-cli >/dev/null && echo ok",
  ]);
  add("Git can verify a remote's certificate", trust.stdout.includes("ok"), trust.stderr.trim());

  // The prebuilt workspace is installed, not cached.
  const prebuilt = probe(
    [
      'node -e \'const p=require("/opt/mate/prebuilt/node_modules/context-mode/package.json");' +
        'const q=require("/opt/mate/prebuilt/node_modules/@uniqbit/mate-opencode-plugin/package.json");' +
        "console.log(p.version, q.version)'",
    ],
    { network: false },
  );
  add(
    "the prebuilt workspace holds installed packages",
    prebuilt.status === 0 && prebuilt.stdout.includes(expected.mateVersion),
    prebuilt.stdout.trim() || prebuilt.stderr.trim(),
  );

  const assets = probe(
    [
      "test -f /opt/mate/prebuilt/node_modules/context-mode/build/adapters/opencode/plugin.js",
      "&& test -f /opt/mate/prebuilt/node_modules/context-mode/skills/context-mode/SKILL.md",
      "&& echo ok",
    ],
    { network: false },
  );
  add(
    "the prebuilt workspace carries its generated assets",
    assets.stdout.includes("ok"),
    assets.stderr.trim(),
  );

  // Native builds and installation scripts completed at build time: a module
  // that only unpacked would not load.
  const native = probe(
    ["node -e \"require('/opt/mate/prebuilt/node_modules/better-sqlite3')\"", "&& echo ok"],
    { network: false },
  );
  add("native modules in the bundle load", native.stdout.includes("ok"), native.stderr.trim());

  // Copying the bundle to a companion-local path must not break it: the
  // packages, their internal links, and their native assets have to work where
  // startup actually puts them.
  const relocated = probe(
    [
      "cp -r /opt/mate/prebuilt /tmp/relocated",
      "&& node -e \"require('/tmp/relocated/node_modules/better-sqlite3')\"",
      "&& node -e \"require('/tmp/relocated/node_modules/context-mode/package.json')\"",
      "&& test -f /tmp/relocated/node_modules/context-mode/build/adapters/opencode/plugin.js",
      "&& echo ok",
    ],
    { network: false },
  );
  add(
    "the bundle still works after being copied to another path",
    relocated.stdout.includes("ok"),
    relocated.stderr.trim(),
  );

  // No credential, no operator configuration, no update state.
  const clean = probe(
    [
      "! test -e /home/mate/.mate/update-state-uniqbit-mate.yaml",
      "&& ! test -e /home/mate/.mate/update-state-uniqbit-mate-canary.yaml",
      "&& ! test -e /root/.mate",
      "&& ! test -e /home/mate/.gitconfig",
      "&& ! test -e /etc/mate/appliance.yaml",
      "&& ! test -e /home/mate/.opencode/auth.json",
      "&& echo ok",
    ],
    { network: false },
  );
  add(
    "no credential, identity, configuration or update state is baked in",
    clean.stdout.includes("ok"),
    clean.stderr.trim(),
  );

  // The container does not run as root, and owns the home directory it writes.
  const identity = probe(["id -u; id -un; stat -c '%u' /home/mate; stat -c '%u' /companions"], {
    network: false,
  });
  const [uid, name, homeOwner, companionsOwner] = identity.stdout.trim().split("\n");
  add(
    "the default user is unprivileged",
    uid === String(expected.uid) && uid !== "0",
    `runs as ${name} (uid ${uid})`,
  );
  add(
    "the running user owns its home directory and the companions mount point",
    homeOwner === String(expected.uid) && companionsOwner === String(expected.uid),
    `home owned by ${homeOwner}, /companions by ${companionsOwner}`,
  );

  return checks;
}

/**
 * The final filesystem can be clean while an intermediate layer still holds a
 * secret that a later layer deleted — deletion is a whiteout, not an erasure.
 * So the layers themselves are read, not just the image they compose to.
 */
export function runLayerScan(runtime: string, image: string, workDir: string): Check[] {
  const archive = path.join(workDir, "image.tar");
  const saved = spawnSync(runtime, ["save", "--output", archive, image], { encoding: "utf8" });
  if (saved.status !== 0) {
    return [
      {
        name: "every layer, including intermediate ones, is free of credentials",
        ok: false,
        detail: `could not export the image: ${saved.stderr.trim()}`,
      },
    ];
  }

  const listed = spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
  const entries = listed.stdout.split("\n");

  // Paths that would only exist because something was configured or
  // authenticated during the build.
  const forbidden =
    /(^|\/)(\.npmrc|\.netrc|\.git-credentials|\.gitconfig|id_rsa|id_ed25519|auth\.json|credentials(\.json)?|update-state-[^/]*\.yaml)$/;
  const offenders = entries.filter((entry) => forbidden.test(entry));

  const checks: Check[] = [
    {
      name: "every layer, including intermediate ones, is free of credentials",
      ok: offenders.length === 0,
      detail: offenders.join("\n") || "none",
    },
  ];

  fs.rmSync(archive, { force: true });
  return checks;
}

/**
 * The compatibility check package presence cannot stand in for: a container
 * started against a fresh, fully loaded companion with no outbound network,
 * asserting both services answer and that no package manager ran.
 */
export function runOfflineStartup(runtime: string, image: string, companionsDir: string): Check[] {
  const name = `mate-verify-${Math.random().toString(36).slice(2, 10)}`;
  const volume = `${name}-companions`;
  const agentPort = 4096;
  const studioPort = 4097;
  const checks: Check[] = [];

  // The companion is served from a volume rather than a host bind mount.
  //
  // That is what a real deployment uses, and on a developer machine whose
  // container runtime is a VM it is also the difference between a 25-second
  // startup and a twenty-minute one: preparation copies some thirty thousand
  // files, and a bind mount across the host boundary makes each of them a
  // round trip. Measuring that would be measuring the developer's laptop, not
  // the appliance.
  spawnSync(runtime, ["volume", "create", volume], { stdio: "ignore" });
  const seeded = spawnSync(
    runtime,
    [
      "run",
      "--rm",
      "--volume",
      `${companionsDir}:/seed:ro,z`,
      "--volume",
      `${volume}:/companions`,
      "--user",
      "0:0",
      "--entrypoint",
      "bash",
      image,
      "-lc",
      "cp -r /seed/. /companions/ && chown -R 10001:10001 /companions",
    ],
    { encoding: "utf8" },
  );
  if (seeded.status !== 0) {
    spawnSync(runtime, ["volume", "rm", "--force", volume], { stdio: "ignore" });
    return [
      {
        name: "a freshly cloned companion can be placed on the companions volume",
        ok: false,
        detail: seeded.stderr.trim(),
      },
    ];
  }

  const container = spawnSync(
    runtime,
    [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      "none",
      "--volume",
      `${volume}:/companions`,
      image,
    ],
    { encoding: "utf8" },
  );

  if (container.status !== 0) {
    spawnSync(runtime, ["volume", "rm", "--force", volume], { stdio: "ignore" });
    checks.push({
      name: "the container starts offline against a fresh companion",
      ok: false,
      detail: container.stderr.trim(),
    });
    return checks;
  }

  const readLogs = (): string => {
    const result = spawnSync(runtime, ["logs", name], { encoding: "utf8" });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  };
  const running = (): boolean =>
    spawnSync(runtime, ["inspect", "-f", "{{.State.Running}}", name], {
      encoding: "utf8",
    }).stdout.trim() === "true";

  // Nothing in the process tree may ever be a package manager or an installer.
  // Read from /proc rather than `ps`, which the slim base image does not carry
  // — and which the appliance has no reason to add.
  const processTree = (): string =>
    spawnSync(
      runtime,
      [
        "exec",
        name,
        "bash",
        "-lc",
        'for p in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$p" 2>/dev/null; echo; done',
      ],
      { encoding: "utf8" },
    ).stdout ?? "";
  // Asked from inside the container: with no network there is nothing to
  // publish a port on, but the container's own loopback still answers.
  const httpStatus = (port: number): string =>
    spawnSync(
      runtime,
      [
        "exec",
        name,
        "node",
        "-e",
        `fetch("http://127.0.0.1:${port}/").then((r) => console.log(r.status), () => console.log(""))`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    ).stdout?.trim() ?? "";
  const installers =
    /\b(npm|pnpm|yarn|bun (add|install|pm)|uv (pip|tool|add)|pip|cargo|node-gyp|prebuild-install|curl \S*install)\b/;

  try {
    // Readiness is both ports answering, which is the only signal that means
    // the appliance is actually serving. Preparation is a filesystem copy of a
    // few hundred packages and can take minutes on a slow volume, so the wait
    // is generous — and the container exiting ends it early rather than
    // burning the whole budget.
    //
    // The process tree is sampled throughout rather than once at the end: the
    // claim is that no installer runs *at any point* in startup, and a single
    // look after the fact could not see one that had already finished.
    let ready = false;
    let sawInstaller = "";
    const deadline = Date.now() + 1_200_000;
    while (Date.now() < deadline) {
      const tree = processTree();
      const offending = tree.split("\n").filter((line) => installers.test(line));
      if (offending.length > 0) sawInstaller = offending.join("\n");

      const answered = ["", ""].map((_, index) => {
        const port = index === 0 ? agentPort : studioPort;
        return httpStatus(port);
      });
      if (answered.every((code) => code.startsWith("2"))) {
        ready = true;
        break;
      }
      if (!running()) break;
      spawnSync("sleep", ["3"]);
    }

    const logs = readLogs();
    checks.push({
      name: "startup prepares dependencies from the filesystem alone",
      ok: ready,
      detail: logs.slice(-2000),
    });

    checks.push({
      name: "no package manager or installer runs in the container at any point",
      ok: sawInstaller === "",
      detail: sawInstaller || "none",
    });

    // Both answered together above, which is what readiness means here: the
    // container never reports itself ready with only one process serving.
    for (const [what, port] of [
      ["the agent session", agentPort],
      ["Studio", studioPort],
    ] as const) {
      const code = httpStatus(port);
      checks.push({
        name: `${what} answers over HTTP`,
        ok: code.startsWith("2"),
        detail: `port ${port} returned ${code || "nothing"}`,
      });
    }

    // The companion's committed MCP entry has to resolve to an installed server:
    // spawned the way the session spawns it, offline, it must answer.
    const mcp = spawnSync(
      runtime,
      ["exec", name, "node", "-e", MCP_ANSWERS, "/companions/acme/.opencode/opencode.json"],
      { encoding: "utf8", timeout: 60_000 },
    );
    checks.push({
      name: "the committed Context7 MCP entry starts offline and answers",
      ok: mcp.status === 0 && mcp.stdout.includes('"serverInfo"'),
      detail: [
        `status ${mcp.status ?? "none"}${mcp.error ? `, ${mcp.error.message}` : ""}`,
        (mcp.stdout || mcp.stderr || "no output").trim().slice(0, 500),
        spawnSync(runtime, ["exec", name, "cat", "/companions/acme/.opencode/opencode.json"], {
          encoding: "utf8",
        }).stdout?.slice(0, 500) ?? "",
      ].join("\n"),
    });

    // Stopping the container must stop both processes and exit zero.
    spawnSync(runtime, ["stop", "--time", "30", name], { encoding: "utf8" });
    const status = spawnSync(runtime, ["inspect", "-f", "{{.State.ExitCode}}", name], {
      encoding: "utf8",
    });
    checks.push({
      name: "a stop exits zero with nothing left running",
      ok: status.stdout.trim() === "0",
      detail: `exit status ${status.stdout.trim()}`,
    });
  } finally {
    spawnSync(runtime, ["rm", "--force", name], { stdio: "ignore" });
    spawnSync(runtime, ["volume", "rm", "--force", volume], { stdio: "ignore" });
  }

  return checks;
}

/** Printed as each check lands, so a long verification is observable while it runs. */
function report(checks: Check[]): Check[] {
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "ok  " : "FAIL"}  ${check.name}\n`);
    if (!check.ok) process.stdout.write(`      ${check.detail.replace(/\n/g, "\n      ")}\n`);
  }
  return checks;
}

function main(argv: string[]): number {
  const runtime = findContainerRuntime();
  if (runtime === null) {
    process.stderr.write("verify-image: no container runtime found; install podman or docker.\n");
    return 1;
  }

  const inputs = readImageInputs();
  const image = option(argv, "image") ?? `mate-appliance:${inputs.mate.minimum_compatible}`;
  const mateVersion = option(argv, "mate-version") ?? inputs.mate.minimum_compatible;
  const skipStartup = argv.includes("--no-startup");

  const checks = report(
    runChecks(probeFor(runtime, image), {
      mateVersion,
      opencodeVersion: inputs.opencode.version,
      uid: inputs.runtime.uid,
      user: inputs.runtime.user,
    }),
  );

  const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mate-layers-"));
  try {
    checks.push(...report(runLayerScan(runtime, image, scanRoot)));
  } finally {
    fs.rmSync(scanRoot, { recursive: true, force: true });
  }

  // The prebuilt workspace's own manifest, readable without starting anything.
  const manifest = probeFor(runtime, image)(["cat", inputs.prebuilt_workspace.manifest_file], {
    network: false,
  });
  checks.push(
    ...report([
      {
        name: "the prebuilt workspace records its versions and its target",
        ok: manifest.status === 0 && manifest.stdout.includes(mateVersion),
        detail: manifest.stdout.trim() || manifest.stderr.trim(),
      },
    ]),
  );

  if (!skipStartup) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-verify-"));
    try {
      makeFreshCompanion(root);
      checks.push(...report(runOfflineStartup(runtime, image, root)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  let failed = 0;
  for (const check of checks) {
    if (!check.ok) failed += 1;
  }
  process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
