import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { openspecFinisher } from "./cli/commands/artifact/finish/openspec";
import { collectDoctorReport } from "./cli/commands/doctor";
import { FRAMEWORK_NAME } from "./framework";
import { ConfigStore } from "./lib/orchestrator/config-store";
import { GlobalConfigStore } from "./lib/orchestrator/global-config-store";
import { createOpenspecPlugin, MATE_SPECS_RULE } from "./tools/setup/capabilities/openspec";
import { findRealOpenSpec } from "../test/real-openspec";

/**
 * Mate's OpenSpec conventions end to end against the real OpenSpec CLI: the
 * config capability sync writes, a change proposed, archived and published, and
 * the main spec it leaves behind. Each test isolates OpenSpec's data and config
 * directories. Skipped where no real `openspec` is installed.
 *
 * These guard the upstream behavior Mate relies on: `rules.specs` reaching the
 * spec instructions, `openspec archive` keeping an existing header, Mate's flat
 * header passing strict validation, and OpenSpec's set of known artifact IDs.
 */

const REAL_OPENSPEC = findRealOpenSpec();
/** Each test spawns the real CLI several times; Bun's 5s default trips under a loaded full-suite run. */
const OPENSPEC_TEST_TIMEOUT = 30_000;

const tempRoots: string[] = [];
/** A session's companion pointer would otherwise win over the sandbox in doctor's root resolution. */
const ROOT_ENV_KEYS = ["MATE_ARTIFACT_PATH", "MATE_REPO_ID", "MATE_REPO_PATH"] as const;
const originalRootEnv = ROOT_ENV_KEYS.map((key) => [key, process.env[key]] as const);

beforeEach(() => {
  for (const key of ROOT_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of originalRootEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Sandbox {
  root: string;
  companion: string;
  openspec: (args: string[]) => { status: number | null; stdout: string; stderr: string };
}

/** A companion seeded by Mate's own capability sync with `mate-v1` selected. */
async function makeSandbox(): Promise<Sandbox> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openspec-conventions-")));
  tempRoots.push(root);
  const companion = path.join(root, "acme-companion");
  fs.mkdirSync(companion);
  const plugin = createOpenspecPlugin({
    runCommand: mock(async () => {}),
    isCommandOnPath: (command: string) => command === "openspec",
    getInstalledVersion: async () => undefined,
  });
  await plugin.apply({
    companionPath: companion,
    activeProviders: [],
    mode: "sync",
    config: { allowedAgents: [], capabilities: [{ name: "openspec" }] },
  });

  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  return {
    root,
    companion,
    openspec: (args) => spawnSync(REAL_OPENSPEC!, args, { cwd: companion, env, encoding: "utf8" }),
  };
}

function expectOk(result: ReturnType<Sandbox["openspec"]>, label: string): string {
  if (result.status !== 0) {
    throw new Error(`openspec ${label} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const DELTA_COMMENT = `<!-- mate:delta
change: CHANGE
capability: widget
scopes:
  - repository: acme/product
    area: packages/web
-->`;

/** The YAML frontmatter Mate deltas carried before the `mate:delta` comment. */
const LEGACY_DELTA_HEADER = `---
type: delta-spec
change: CHANGE
capability: widget
tags: [openspec/change, openspec/spec, openspec/delta]
scopes:
  - repository: acme/product
    area: packages/web
---`;

const CANONICAL_HEADER = `---
type: spec
capability: widget
repository: acme/product
areas: [packages/web]
tags: [openspec/spec]
---
`;

/** A complete mate-v1 change whose delta for `widget` uses `section` (ADDED or MODIFIED). */
function proposeChange(sandbox: Sandbox, name: string, section: string, requirement: string): void {
  expectOk(sandbox.openspec(["new", "change", name]), `new change ${name}`);
  const change = path.join(sandbox.companion, "openspec", "changes", name);
  const scopes = "scopes:\n  - repository: acme/product\n    area: packages/web\n---\n\n";
  fs.writeFileSync(
    path.join(change, "proposal.md"),
    `---\ntype: change-proposal\nchange: ${name}\nschema: mate-v1\n${scopes}## Why\n\nThe widget needs a reason that is long enough to pass.\n\n## What Changes\n\n- Changes the widget.\n`,
  );
  fs.writeFileSync(
    path.join(change, "design.md"),
    `---\ntype: change-design\nchange: ${name}\n${scopes}## Context\n\nA widget.\n`,
  );
  fs.writeFileSync(
    path.join(change, "tasks.md"),
    `---\ntype: change-tasks\nchange: ${name}\n${scopes}## 1. Work\n\n- [x] 1.1 Build the widget\n`,
  );
  fs.mkdirSync(path.join(change, "specs", "widget"), { recursive: true });
  fs.writeFileSync(
    path.join(change, "specs", "widget", "spec.md"),
    `${DELTA_COMMENT.replace("CHANGE", name)}\n\n# widget delta\n\n## ${section} Requirements\n\n### Requirement: Widget renders\n${requirement}\n**Area:** \`packages/web\`\n\n#### Scenario: Widget shows\n- **WHEN** the page loads\n- **THEN** the widget shows\n`,
  );
}

function archive(sandbox: Sandbox, name: string): void {
  expectOk(sandbox.openspec(["validate", name, "--strict"]), `validate ${name}`);
  // What `mate artifact archive` leaves behind; it moves into the archive with the change.
  fs.writeFileSync(
    path.join(sandbox.companion, "openspec", "changes", name, "delivery.yaml"),
    `version: 1\nchange: ${name}\ndeliveries:\n  - repository: acme/product\n    notApplicable: spec only\n`,
  );
  expectOk(sandbox.openspec(["archive", name, "--yes"]), `archive ${name}`);
}

function mainSpecPath(sandbox: Sandbox): string {
  return path.join(sandbox.companion, "openspec", "specs", "widget", "spec.md");
}

/**
 * Replaces the placeholder Purpose `openspec archive` writes for a new capability,
 * as its author must before the spec passes strict validation.
 */
function writePurpose(sandbox: Sandbox): void {
  const spec = fs.readFileSync(mainSpecPath(sandbox), "utf8");
  const written = spec.replace(
    /## Purpose\n[\s\S]*?\n(?=## Requirements)/,
    "## Purpose\nRenders the acme widget on every product page that embeds it.\n\n",
  );
  expect(written).not.toBe(spec);
  fs.writeFileSync(mainSpecPath(sandbox), written);
}

async function publishResolve(sandbox: Sandbox, name: string): Promise<void> {
  const result = await openspecFinisher(sandbox.companion).resolve(name);
  expect(result.ok).toBe(true);
}

describe.skipIf(!REAL_OPENSPEC)("Mate OpenSpec conventions with the real CLI", () => {
  test(
    "the Mate rules.specs entry reaches the spec instructions without a warning",
    async () => {
      const sandbox = await makeSandbox();
      expectOk(sandbox.openspec(["new", "change", "demo"]), "new change");

      const instructions = sandbox.openspec([
        "instructions",
        "specs",
        "--change",
        "demo",
        "--json",
      ]);

      expect(instructions.status).toBe(0);
      expect(JSON.parse(instructions.stdout).rules).toEqual([MATE_SPECS_RULE]);
      expect(instructions.stderr).not.toContain("Unknown artifact ID");
    },
    OPENSPEC_TEST_TIMEOUT,
  );

  test(
    "a spec born by archive gets the flat header at publish and passes strict validation",
    async () => {
      const sandbox = await makeSandbox();
      proposeChange(sandbox, "add-widget", "ADDED", "The system SHALL render the widget.");
      archive(sandbox, "add-widget");
      writePurpose(sandbox);

      await publishResolve(sandbox, "add-widget");

      const spec = fs.readFileSync(mainSpecPath(sandbox), "utf8");
      expect(spec.startsWith(CANONICAL_HEADER)).toBe(true);
      expect(spec).toContain("### Requirement: Widget renders");
      expect(spec).toContain("**Area:** `packages/web`");
      expectOk(sandbox.openspec(["validate", "--specs", "--strict"]), "validate --specs");
    },
    OPENSPEC_TEST_TIMEOUT,
  );

  test(
    "a legacy delta header an agent copied onto the main spec is replaced at publish",
    async () => {
      const sandbox = await makeSandbox();
      proposeChange(sandbox, "add-widget", "ADDED", "The system SHALL render the widget.");
      archive(sandbox, "add-widget");
      writePurpose(sandbox);
      /** What an agent improvising during archive writes: the delta's own header. */
      const born = fs
        .readFileSync(mainSpecPath(sandbox), "utf8")
        .replace(/^---\n[\s\S]*?\n---\n/, "");
      const copied = `${LEGACY_DELTA_HEADER.replace("CHANGE", "add-widget")}\n${born}`;
      fs.writeFileSync(mainSpecPath(sandbox), copied);

      await publishResolve(sandbox, "add-widget");

      expect(fs.readFileSync(mainSpecPath(sandbox), "utf8")).toBe(`${CANONICAL_HEADER}${born}`);
      expectOk(sandbox.openspec(["validate", "--specs", "--strict"]), "validate --specs");
    },
    OPENSPEC_TEST_TIMEOUT,
  );

  test(
    "a mate:delta comment an agent copied onto the main spec is replaced at publish",
    async () => {
      const sandbox = await makeSandbox();
      proposeChange(sandbox, "add-widget", "ADDED", "The system SHALL render the widget.");
      archive(sandbox, "add-widget");
      writePurpose(sandbox);
      const born = fs.readFileSync(mainSpecPath(sandbox), "utf8");
      fs.writeFileSync(
        mainSpecPath(sandbox),
        `${DELTA_COMMENT.replace("CHANGE", "add-widget")}\n${born}`,
      );

      await publishResolve(sandbox, "add-widget");

      expect(fs.readFileSync(mainSpecPath(sandbox), "utf8")).toBe(`${CANONICAL_HEADER}${born}`);
      expectOk(sandbox.openspec(["validate", "--specs", "--strict"]), "validate --specs");
    },
    OPENSPEC_TEST_TIMEOUT,
  );

  test(
    "a delta filled in from the synced mate-v1 template passes strict validation",
    async () => {
      const sandbox = await makeSandbox();
      proposeChange(sandbox, "add-widget", "ADDED", "The system SHALL render the widget.");
      const template = fs.readFileSync(
        path.join(sandbox.companion, "openspec", "schemas", "mate-v1", "templates", "spec.md"),
        "utf8",
      );
      const filled = template
        .replace("<change-name>", "add-widget")
        .replace("<capability>", "widget")
        .replace("org/repository", "acme/product")
        .replace("area: .", "area: packages/web")
        .replace(
          /(## Purpose\n\n)<!--[\s\S]*?-->/,
          "$1Renders the acme widget on every product page that embeds it.",
        )
        .replace("<!-- requirement name -->", "Widget renders")
        .replace(
          /<!-- Write the normative requirement\.[\s\S]*?-->/,
          "The system SHALL render the widget.\n**Area:** `packages/web`",
        )
        .replace("<!-- scenario name -->", "Widget shows")
        .replace("<!-- condition -->", "the page loads")
        .replace("<!-- expected outcome -->", "the widget shows");
      expect(filled.startsWith("<!-- mate:delta\n")).toBe(true);
      fs.writeFileSync(
        path.join(
          sandbox.companion,
          "openspec",
          "changes",
          "add-widget",
          "specs",
          "widget",
          "spec.md",
        ),
        filled,
      );

      const validated = sandbox.openspec(["validate", "add-widget", "--strict"]);
      expectOk(validated, "validate add-widget");
      expect(`${validated.stdout}${validated.stderr}`).not.toMatch(/warn/i);
      const archived = sandbox.openspec(["archive", "add-widget", "--yes"]);
      expectOk(archived, "archive add-widget");
      expect(`${archived.stdout}${archived.stderr}`).not.toMatch(/warn/i);
    },
    OPENSPEC_TEST_TIMEOUT,
  );

  test(
    "archiving a later change keeps the main spec's header, and publish leaves it alone",
    async () => {
      const sandbox = await makeSandbox();
      proposeChange(sandbox, "add-widget", "ADDED", "The system SHALL render the widget.");
      archive(sandbox, "add-widget");
      writePurpose(sandbox);
      await publishResolve(sandbox, "add-widget");

      proposeChange(sandbox, "tune-widget", "MODIFIED", "The system SHALL render the widget fast.");
      archive(sandbox, "tune-widget");
      const archived = fs.readFileSync(mainSpecPath(sandbox), "utf8");
      await publishResolve(sandbox, "tune-widget");

      expect(archived.startsWith(CANONICAL_HEADER)).toBe(true);
      expect(archived).toContain("render the widget fast");
      expect(fs.readFileSync(mainSpecPath(sandbox), "utf8")).toBe(archived);
      expectOk(sandbox.openspec(["validate", "--specs", "--strict"]), "validate --specs");
    },
    OPENSPEC_TEST_TIMEOUT,
  );

  test(
    "doctor flags exactly the rules keys OpenSpec ignores",
    async () => {
      const sandbox = await makeSandbox();
      const configPath = path.join(sandbox.companion, "openspec", "config.yaml");
      fs.appendFileSync(
        configPath,
        "  proposal:\n    - Name the customer.\n  implementation:\n    - Run the widget tests.\n  brief:\n    - Keep it short.\n",
      );
      const frameworkConfig = path.join(
        sandbox.companion,
        `.${FRAMEWORK_NAME}`,
        "config",
        "framework.yaml",
      );
      fs.mkdirSync(path.dirname(frameworkConfig), { recursive: true });
      await new ConfigStore(frameworkConfig).save({
        allowedAgents: [],
        capabilities: [{ name: "openspec" }],
      });
      expectOk(sandbox.openspec(["new", "change", "demo"]), "new change");

      const instructions = sandbox.openspec([
        "instructions",
        "specs",
        "--change",
        "demo",
        "--json",
      ]);
      const ignoredByOpenSpec = [
        ...instructions.stderr.matchAll(/Unknown artifact ID in rules: "([^"]+)"/g),
      ].map((match) => match[1]);
      const report = await collectDoctorReport({
        cwd: sandbox.companion,
        globalConfigStore: new GlobalConfigStore(path.join(sandbox.root, "global.yaml")),
        inspectPlugins: async () => ({ failures: [], capabilities: [] }),
      });

      expect(ignoredByOpenSpec.toSorted()).toEqual(["brief", "implementation"]);
      expect(report.openspecRuleWarnings?.map((warning) => warning.key).toSorted()).toEqual(
        ignoredByOpenSpec.toSorted(),
      );
    },
    OPENSPEC_TEST_TIMEOUT,
  );
});
