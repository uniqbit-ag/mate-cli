import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mock } from "bun:test";

import { git } from "./git-checkouts";
import { findRealOpenSpec } from "./real-openspec";
import { createOpenspecPlugin } from "../src/tools/setup/capabilities/openspec";
import { runOpenSpec, type RunOpenSpec } from "../src/lib/openspec-cli";

/**
 * Real Git and OpenSpec layouts for staging tests: a bare companion remote, clones of it
 * seeded by Mate's openspec capability sync, and changes archived locally the way
 * `mate artifact archive` leaves them.
 */

export const REAL_OPENSPEC = findRealOpenSpec();

export interface StagingFixture {
  root: string;
  remote: string;
  env: NodeJS.ProcessEnv;
  runOpenSpec: RunOpenSpec;
  clone: (name: string) => string;
  cleanup: () => void;
}

const SCOPES = "scopes:\n  - repository: acme/product\n    area: packages/web\n---\n\n";

/** A canonical `widget`-style spec with one requirement, as a published companion holds it. */
export function canonicalSpec(capability: string, requirementName: string): string {
  return `---\ntype: spec\ncapability: ${capability}\nrepository: acme/product\nareas: [packages/web]\ntags: [openspec/spec]\n---\n\n# ${capability} Specification\n\n## Purpose\nThe ${capability} capability exists so the tests have a real canonical spec.\n\n## Requirements\n### Requirement: ${requirementName}\nThe ${capability} SHALL work.\n**Area:** \`packages/web\`\n\n#### Scenario: Works\n- **WHEN** used\n- **THEN** it works\n`;
}

/** A bare companion remote seeded with `specs`. */
export async function makeStagingFixture(
  specs: Record<string, string> = {},
): Promise<StagingFixture> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-staging-")));
  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  const plugin = createOpenspecPlugin({
    runCommand: mock(async () => {}),
    isCommandOnPath: (command: string) => command === "openspec",
    getInstalledVersion: async () => undefined,
  });
  await plugin.apply({
    companionPath: seed,
    activeProviders: [],
    mode: "sync",
    config: { allowedAgents: [], capabilities: [{ name: "openspec" }] },
  });
  for (const [capability, source] of Object.entries(specs)) {
    const dir = path.join(seed, "openspec", "specs", capability);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spec.md"), source);
  }
  git(root, "init", "-q", seed);
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "seed");
  const remote = path.join(root, "acme-companion.git");
  git(root, "clone", "-q", "--bare", seed, remote);

  return {
    root,
    remote,
    env,
    runOpenSpec: (args, options) => runOpenSpec(args, { ...options, env }),
    clone(name) {
      const target = path.join(root, name);
      git(root, "clone", "-q", remote, target);
      // One person per clone, so authorship tells them apart.
      git(target, "config", "user.name", name);
      git(target, "config", "user.email", `${name}@example.com`);
      return target;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface ChangeOptions {
  /** `## <section> Requirements` blocks for each capability's delta. */
  deltas: Record<string, string>;
  branch?: string;
  dependsOn?: string[];
  /** Records the branch as merged, answered by the user. */
  merged?: boolean;
}

/** A delivery's merge result as `artifact link --confirm-merged` records it. */
export const mergedYaml =
  "    merge:\n      state: merged\n      source: user\n      checkedAt: 2026-11-12T10:00:00.000Z\n";

/** Records every branch delivery of an archive's `delivery.yaml` as merged. */
export function recordMerged(archiveDir: string): void {
  const file = path.join(archiveDir, "delivery.yaml");
  const source = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, source.replace(/(    branch: .+\n)/g, `$1${mergedYaml}`));
}

function runRealOpenSpec(fixture: StagingFixture, companion: string, args: string[]): void {
  const result = spawnSync(process.execPath, [REAL_OPENSPEC!, ...args], {
    cwd: companion,
    env: fixture.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`openspec ${args.join(" ")}: ${result.stdout}\n${result.stderr}`);
  }
}

/** A complete mate-full change with a Delivery Record, archived locally and left uncommitted. */
export function archiveLocally(
  fixture: StagingFixture,
  companion: string,
  name: string,
  options: ChangeOptions,
): string {
  proposeLocally(fixture, companion, name, options);
  runRealOpenSpec(fixture, companion, ["archive", name, "--yes"]);
  const anchor = fs
    .readdirSync(path.join(companion, "openspec", "changes", "archive"))
    .find((entry) => entry.endsWith(`-${name}`));
  if (!anchor) throw new Error(`no archive for ${name}`);
  return anchor;
}

/**
 * A complete mate-full change with a Delivery Record, left active in `openspec/changes/<name>/`
 * as submit finds it; `state` and `specBase` go into its record when given.
 */
export function proposeLocally(
  fixture: StagingFixture,
  companion: string,
  name: string,
  options: ChangeOptions & { state?: "submitted"; specBase?: string },
): string {
  runRealOpenSpec(fixture, companion, ["new", "change", name]);
  const change = path.join(companion, "openspec", "changes", name);
  const depends = options.dependsOn ? `dependsOn: [${options.dependsOn.join(", ")}]\n` : "";
  fs.writeFileSync(
    path.join(change, "proposal.md"),
    `---\ntype: change-proposal\nchange: ${name}\nschema: mate-full\n${depends}${SCOPES}## Why\n\nThe acme widget needs a reason that is long enough to pass.\n\n## What Changes\n\n- Changes the widget.\n`,
  );
  fs.writeFileSync(
    path.join(change, "design.md"),
    `---\ntype: change-design\nchange: ${name}\n${SCOPES}## Context\n\nA widget.\n`,
  );
  fs.writeFileSync(
    path.join(change, "tasks.md"),
    `---\ntype: change-tasks\nchange: ${name}\n${SCOPES}## 1. Work\n\n- [x] 1.1 Build\n`,
  );
  for (const [capability, body] of Object.entries(options.deltas)) {
    fs.mkdirSync(path.join(change, "specs", capability), { recursive: true });
    fs.writeFileSync(
      path.join(change, "specs", capability, "spec.md"),
      `<!-- mate:delta\nchange: ${name}\ncapability: ${capability}\nscopes:\n  - repository: acme/product\n    area: packages/web\n-->\n\n${body}`,
    );
  }
  const merge = options.merged ? mergedYaml : "";
  const delivery = options.branch
    ? `  - repository: acme/product\n    branch: ${options.branch}\n${merge}`
    : "  - repository: acme/product\n    notApplicable: spec only\n";
  const state = options.state ? `state: ${options.state}\n` : "";
  const specBase = options.specBase ? `specBase: ${options.specBase}\n` : "";
  fs.writeFileSync(
    path.join(change, "delivery.yaml"),
    `version: 1\nchange: ${name}\n${state}${specBase}deliveries:\n${delivery}`,
  );
  return change;
}

/** A requirement block for a delta section. */
export function requirement(section: string, name: string, text: string): string {
  return `## ${section} Requirements\n\n### Requirement: ${name}\n${text}\n**Area:** \`packages/web\`\n\n#### Scenario: ${name} works\n- **WHEN** used\n- **THEN** ${text.toLowerCase()}\n\n`;
}

export interface LocalChangeOptions {
  /** Recorded for `acme/product`; none records an unlinked change. */
  branch?: string;
  state?: "active" | "submitted" | "dropped";
  /** Extra files below the change folder, by relative path. */
  files?: Record<string, string>;
}

/** An active change folder with a Delivery Record, written without OpenSpec. */
export function changeLocally(
  companion: string,
  name: string,
  options: LocalChangeOptions = {},
): string {
  const change = path.join(companion, "openspec", "changes", name);
  fs.mkdirSync(change, { recursive: true });
  fs.writeFileSync(
    path.join(change, "proposal.md"),
    `---\ntype: change-proposal\nchange: ${name}\nschema: mate-full\n${SCOPES}## Why\n\nThe acme widget changes.\n`,
  );
  for (const [file, text] of Object.entries(options.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(change, file)), { recursive: true });
    fs.writeFileSync(path.join(change, file), text);
  }
  const state = options.state ? `state: ${options.state}\n` : "";
  const deliveries = options.branch
    ? `deliveries:\n  - repository: acme/product\n    branch: ${options.branch}\n`
    : "deliveries: []\n";
  fs.writeFileSync(
    path.join(change, "delivery.yaml"),
    `version: 1\nchange: ${name}\n${state}${deliveries}`,
  );
  return change;
}

/** A file's content at `ref` in `repo`, or null. */
export function showAt(repo: string, ref: string, file: string): string | null {
  try {
    return git(repo, "show", `${ref}:${file}`);
  } catch {
    return null;
  }
}
