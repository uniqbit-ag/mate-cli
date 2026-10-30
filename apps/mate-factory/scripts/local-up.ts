#!/usr/bin/env bun
/**
 * Runs the factory locally with the Mate on this working tree.
 *
 * A base image is built from the unchanged release recipe and reused until its
 * inputs change; the working tree is packed and installed on top of it as a
 * separate, local-only image. The container serves a clone of a companion,
 * made by its own startup from a read-only mount, so the source is never
 * written. Nothing is pushed, and no credential is read or written.
 *
 *   bun scripts/local-up.ts [up|down|reset|logs] [--companion <path>] [--rebuild-base] [--port <n>]
 *
 * It runs as root, privileged, with the three factory volumes. A Workset agent
 * credential is passed through from the shell's `CLAUDE_CODE_OAUTH_TOKEN` or
 * `ANTHROPIC_API_KEY`, else from the file `mate factory setup` stores, and
 * `MATE_FACTORY_REPOSITORIES` from the shell.
 *
 * See README.md, "Running the factory locally", for the walkthrough.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stringify } from "yaml";

import { findContainerRuntime } from "../src/container-runtime";
import { CONTAINER_ROOT } from "../src/image-inputs";

const REPO_ROOT = path.resolve(CONTAINER_ROOT, "..", "..");
const LOCAL_DIR = path.join(CONTAINER_ROOT, ".local");
const OVERLAY_DIR = path.join(LOCAL_DIR, "overlay");
const COMPOSE_FILE = path.join(LOCAL_DIR, "compose.yaml");

const BASE_TAG = "mate-factory:local-base";
const LOCAL_TAG = "mate-factory:local";
const INPUTS_LABEL = "ai.mate.local-inputs";
const PROJECT = "mate-factory-local";
/** Studio's port inside the container. */
const STUDIO_PORT = 4097;
/** Published on the host one above the local appliance's, so both can run. */
const HOST_PORT = 4098;
const READY_TIMEOUT_MS = 120_000;

export type Command = "up" | "down" | "reset" | "logs";

export interface LocalOptions {
  command: Command;
  companion: string;
  rebuildBase: boolean;
  port: number;
}

class UsageError extends Error {}

const USAGE =
  "usage: local-up.ts [up|down|reset|logs] [--companion <path>] [--rebuild-base] [--port <n>]";

export function parseArgs(argv: string[], home: string = os.homedir()): LocalOptions {
  const commands: Command[] = [];
  let companion = path.join(home, ".mate", "companions", "mate-cli-companion");
  let rebuildBase = false;
  let port = HOST_PORT;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--rebuild-base") {
      rebuildBase = true;
    } else if (arg === "--companion") {
      const value = argv[++index];
      if (!value) throw new UsageError("--companion needs a path");
      companion = value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(value);
    } else if (arg === "--port") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new UsageError("--port needs a port number between 1 and 65535");
      }
      port = value;
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown option ${arg}`);
    } else if (["up", "down", "reset", "logs"].includes(arg)) {
      commands.push(arg as Command);
    } else {
      throw new UsageError(`unknown command ${arg}`);
    }
  }
  if (commands.length > 1) throw new UsageError("name one command");
  return { command: commands[0] ?? "up", companion, rebuildBase, port };
}

// ---------------------------------------------------------------------------
// The base image and its inputs.
// ---------------------------------------------------------------------------

function filesUnder(root: string, relative: string): string[] {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  if (!fs.statSync(absolute).isDirectory()) return [relative];
  return fs.readdirSync(absolute).flatMap((entry) => filesUnder(root, path.join(relative, entry)));
}

/** The sources of every `COPY` from the build context, so the digest follows the recipe. */
function copiedSources(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)]
    .map((match) => match[1]!.trim().split(/\s+/))
    .filter((words) => !words.some((word) => word.startsWith("--from=")))
    .flatMap((words) => words.filter((word) => !word.startsWith("--")).slice(0, -1));
}

/**
 * A digest of everything the release recipe builds from: the recipe, the
 * pins, every lock, and the files it copies. A different digest means the
 * base image no longer matches this branch.
 */
export function localInputsDigest(root: string = CONTAINER_ROOT): string {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const files = new Set(
    ["Dockerfile", "image-inputs.yaml", "locks", ...copiedSources(dockerfile)]
      .flatMap((relative) => filesUnder(root, relative))
      .map((relative) => relative.split(path.sep).join("/")),
  );
  const hash = createHash("sha256");
  for (const relative of [...files].toSorted()) {
    hash.update(`${relative}\0`);
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function needsBaseRebuild(state: {
  imageLabel: string | null;
  digest: string;
  force: boolean;
}): boolean {
  return state.force || state.imageLabel !== state.digest;
}

/** The base image's recorded input digest, or null when it is missing or unlabelled. */
function baseImageLabel(runtime: string): string | null {
  const result = spawnSync(
    runtime,
    ["image", "inspect", "--format", `{{ index .Config.Labels "${INPUTS_LABEL}" }}`, BASE_TAG],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const label = result.stdout.trim();
  return label === "" || label === "<no value>" ? null : label;
}

// ---------------------------------------------------------------------------
// The generated scratch configuration.
// ---------------------------------------------------------------------------

/** Factory mode's state: the inner daemon's data, Sysbox's, and the Worksets' clones and worktrees. */
const FACTORY_VOLUMES = {
  "factory-docker": "/var/lib/docker",
  "factory-sysbox": "/var/lib/sysbox",
  "factory-state": "/var/lib/mate-factory",
};

export function composeFile(options: { companion: string; port: number }): string {
  const name = path.basename(options.companion);
  const environment: Record<string, string> = {
    MATE_COMPANION_REPOS: `file:///seed/${name}=${name}`,
    MATE_COMPANION: name,
    MATE_GIT_SYNC: "false",
    MATE_STUDIO_WRITABLE: "true",
    MATE_STUDIO_TERMINAL: "true",
  };
  // Studio refuses a Host it does not expect, and the browser sends the published port.
  if (options.port !== STUDIO_PORT) {
    environment.MATE_STUDIO_ALLOWED_HOSTS = `localhost:${options.port},127.0.0.1:${options.port}`;
  }
  // null passes the shell's value through, or nothing when it is unset.
  const environmentWithFactory: Record<string, string | null> = {
    ...environment,
    CLAUDE_CODE_OAUTH_TOKEN: null,
    ANTHROPIC_API_KEY: null,
    MATE_FACTORY_REPOSITORIES: null,
    MATE_FACTORY_GIT_NAME: null,
    MATE_FACTORY_GIT_EMAIL: null,
  };
  const project = {
    name: PROJECT,
    services: {
      mate: {
        image: LOCAL_TAG,
        container_name: PROJECT,
        user: "0",
        privileged: true,
        volumes: [
          `${options.companion}:/seed/${name}:ro`,
          "companions:/companions",
          "mate-home:/home/mate",
          "./appliance.yaml:/etc/mate/appliance.yaml:ro",
          ...Object.entries(FACTORY_VOLUMES).map(([volume, target]) => `${volume}:${target}`),
        ],
        ports: [`127.0.0.1:${options.port}:${STUDIO_PORT}`],
        environment: environmentWithFactory,
        stop_grace_period: "30s",
      },
    },
    volumes: {
      companions: {},
      "mate-home": {},
      ...Object.fromEntries(Object.keys(FACTORY_VOLUMES).map((volume) => [volume, {}])),
    },
  };
  return (
    "# Generated by apps/mate-factory/scripts/local-up.ts on every run; edits are overwritten.\n" +
    "# A local working-tree build: never publish this image.\n" +
    stringify(project)
  );
}

export function applianceFile(): string {
  return (
    "# Generated by apps/mate-factory/scripts/local-up.ts on every run; edits are overwritten.\n" +
    "# Deliberately holds no credentials: sign agents in from Studio's terminal,\n" +
    "# and the login stays in the mate-home volume until `factory:local:reset`.\n" +
    stringify({ studioDetachMinutes: 30 })
  );
}

/** The token-bearing address Studio prints, on the host port it is published at. */
export function studioAddress(log: string, port: number): string | null {
  const match = /https?:\/\/[^\s/]+(\/\S*[?&]token=\S+)/.exec(log);
  return match ? `http://localhost:${port}${match[1]}` : null;
}

// ---------------------------------------------------------------------------
// The commands.
// ---------------------------------------------------------------------------

function say(line: string): void {
  process.stderr.write(`factory:local: ${line}\n`);
}

function run(command: string, args: string[], cwd: string = CONTAINER_ROOT): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.slice(0, 2).join(" ")} exited ${result.status ?? "abnormally"}`,
    );
  }
}

function compose(runtime: string, args: string[]): void {
  run(runtime, ["compose", "--file", COMPOSE_FILE, ...args], LOCAL_DIR);
}

function writeScratch(options: LocalOptions): void {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(COMPOSE_FILE, composeFile(options));
  fs.writeFileSync(path.join(LOCAL_DIR, "appliance.yaml"), applianceFile());
}

function checkCompanion(companion: string): void {
  if (!fs.existsSync(path.join(companion, ".git"))) {
    throw new Error(`${companion} is not a Git checkout; name one with --companion <path>`);
  }
  const status = spawnSync("git", ["-C", companion, "status", "--porcelain"], { encoding: "utf8" });
  const changed = status.stdout.split("\n").filter((line) => line.trim() !== "").length;
  if (changed > 0) {
    say(
      `warning: ${companion} has ${changed} uncommitted change(s). ` +
        "The container clones committed history only; commit them to see them in Studio " +
        "(an existing clone is reused until factory:local:reset).",
    );
  }
}

function buildBase(runtime: string, force: boolean): void {
  const digest = localInputsDigest();
  if (!needsBaseRebuild({ imageLabel: baseImageLabel(runtime), digest, force })) {
    say(`reusing ${BASE_TAG}; its inputs are unchanged`);
    return;
  }
  say(`building ${BASE_TAG} from the release recipe (slow the first time)`);
  run("bun", [
    path.join(CONTAINER_ROOT, "scripts", "build.ts"),
    "--tag",
    BASE_TAG,
    "--label",
    `${INPUTS_LABEL}=${digest}`,
  ]);
}

/** A counter that grows with every build, so the running version names the build. */
function localCounter(): string {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

function buildOverlay(runtime: string): string {
  const cliPackage = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "apps", "mate-cli", "package.json"), "utf8"),
  ) as { version: string };
  const counter = localCounter();
  const version = `${cliPackage.version.split("-")[0]}-local.${counter}`;
  const coreTarball = `uniqbit-mate-core-${version}.tgz`;
  const cliTarball = `uniqbit-mate-${version}.tgz`;

  say(`packing the working tree as ${version}`);
  const packed = spawnSync(
    "bash",
    [
      path.join(REPO_ROOT, "pack-local.sh"),
      counter,
      "--no-install",
      "--core-ref",
      `file:/opt/mate/local/${coreTarball}`,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (packed.status !== 0) throw new Error(`pack-local.sh exited ${packed.status ?? "abnormally"}`);
  const tarballs = packed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"));
  const packedPaths = [coreTarball, cliTarball].map((name) => {
    const found = tarballs.find((tarball) => path.basename(tarball) === name);
    if (!found) throw new Error(`pack-local.sh did not report ${name}`);
    return found;
  });

  fs.rmSync(OVERLAY_DIR, { recursive: true, force: true });
  fs.mkdirSync(OVERLAY_DIR, { recursive: true });
  for (const tarball of packedPaths) {
    fs.copyFileSync(tarball, path.join(OVERLAY_DIR, path.basename(tarball)));
  }
  // pack-local.sh writes both tarballs to a temporary directory of its own.
  fs.rmSync(path.dirname(packedPaths[1]!), { recursive: true, force: true });

  say(`building ${LOCAL_TAG}`);
  run(runtime, [
    "build",
    ...(runtime === "podman" ? ["--format", "docker"] : []),
    "--file",
    path.join(CONTAINER_ROOT, "local.Dockerfile"),
    "--build-arg",
    `BASE_IMAGE=${BASE_TAG}`,
    "--build-arg",
    `LOCAL_VERSION=${version}`,
    "--build-arg",
    `CORE_TARBALL=${coreTarball}`,
    "--build-arg",
    `CLI_TARBALL=${cliTarball}`,
    "--tag",
    LOCAL_TAG,
    OVERLAY_DIR,
  ]);
  return version;
}

/** Follows the log until Studio prints its address, the container stops, or time runs out. */
function waitForStudio(runtime: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const follow = spawn(
      runtime,
      [
        "compose",
        "--file",
        COMPOSE_FILE,
        "logs",
        "--follow",
        "--no-color",
        "--no-log-prefix",
        "mate",
      ],
      { cwd: LOCAL_DIR, stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "";
    let settled = false;
    const finish = (address: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      follow.kill();
      if (address === null) {
        const tail = log.trim().split("\n").slice(-30).join("\n");
        process.stderr.write(`${tail}\n`);
      }
      resolve(address);
    };
    const timer = setTimeout(() => {
      say(
        `Studio did not print its address within ${READY_TIMEOUT_MS / 1000}s; the last log lines:`,
      );
      finish(null);
    }, READY_TIMEOUT_MS);
    const read = (chunk: Buffer) => {
      log += chunk.toString();
      const address = studioAddress(log, port);
      if (address !== null) finish(address);
    };
    follow.stdout.on("data", read);
    follow.stderr.on("data", read);
    // The log ends when the container does: startup refused, or Studio stopped.
    follow.on("close", () => {
      if (!settled) say("the container stopped before Studio was ready; the last log lines:");
      finish(null);
    });
  });
}

/** `mate factory setup` stores the Workset agents' credential here. */
export const FACTORY_CREDENTIAL_FILE = path.join(
  os.homedir(),
  ".mate",
  "factory",
  "credential.env",
);
const CREDENTIAL_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

/**
 * The credential compose passes through: the shell's own when it sets one, else the
 * stored one. Only the variable's name is ever reported.
 */
export function factoryCredentialEnv(
  env: NodeJS.ProcessEnv,
  readFile: (file: string) => string | null = (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
): { name: string; value: string; source: "shell" | "file" } | null {
  for (const name of CREDENTIAL_NAMES) {
    if (env[name]) return { name, value: env[name]!, source: "shell" };
  }
  for (const line of (readFile(FACTORY_CREDENTIAL_FILE) ?? "").split("\n")) {
    const separator = line.indexOf("=");
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (separator > 0 && CREDENTIAL_NAMES.includes(name) && value)
      return { name, value, source: "file" };
  }
  return null;
}

async function up(runtime: string, options: LocalOptions): Promise<number> {
  checkCompanion(options.companion);
  const credential = factoryCredentialEnv(process.env);
  if (credential === null) {
    say("no Workset agent credential; run `mate factory setup` to store one");
  } else {
    // Only compose, started from this process, inherits it.
    process.env[credential.name] = credential.value;
    say(
      `Workset agents use ${credential.name} from ${credential.source === "shell" ? "your shell" : FACTORY_CREDENTIAL_FILE}`,
    );
  }
  buildBase(runtime, options.rebuildBase);
  const version = buildOverlay(runtime);
  writeScratch(options);
  compose(runtime, ["up", "--detach", "--force-recreate"]);

  const address = await waitForStudio(runtime, options.port);
  if (address === null) return 1;
  say(`Mate ${version} is serving ${path.basename(options.companion)}`);
  process.stdout.write(`\n  Studio: ${address}\n\n`);
  say("stop with `bun run factory:local:down`, start fresh with `bun run factory:local:reset`");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let options: LocalOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`factory:local: ${error.message}\n${USAGE}\n`);
    return 2;
  }

  const runtime = findContainerRuntime();
  if (runtime === null) {
    say("no container runtime found; install Docker or Podman.");
    return 1;
  }

  try {
    switch (options.command) {
      case "up":
        return await up(runtime, options);
      case "down":
        writeScratch(options);
        compose(runtime, ["down"]);
        say("stopped; the companion clone and agent logins are kept");
        return 0;
      case "reset":
        writeScratch(options);
        compose(runtime, ["down", "--volumes"]);
        fs.rmSync(LOCAL_DIR, { recursive: true, force: true });
        say("removed the container, its volumes, and .local/; the next start clones afresh");
        return 0;
      case "logs":
        writeScratch(options);
        compose(runtime, ["logs", "--follow", "mate"]);
        return 0;
    }
  } catch (error) {
    say((error as Error).message);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
