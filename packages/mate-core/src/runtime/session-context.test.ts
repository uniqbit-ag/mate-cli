import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { companionFrameworkConfigPath, policyDocument } from "./policy";
import { writeProjectionPair } from "./projection";
import { repoLocalRegistryPath } from "./repo-local";
import { defaultSecretPolicy, parseSecretsConfig } from "./secret-patterns";
import {
  SESSION_CONTEXT_PROTOCOL,
  resolveSessionContext,
  sessionContextReply,
} from "./session-context";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** `acme-app` wrapped for the `acme` companion; `companionConfig` is its `framework.yaml`, or none. */
function wrappedRepo(companionConfig: string | null = "allowedAgents:\n  - claude\n") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-context-")));
  tempRoots.push(root);
  const repoRoot = path.join(root, "acme-app");
  const companionPath = path.join(root, "acme");
  fs.mkdirSync(companionPath, { recursive: true });

  const registryPath = repoLocalRegistryPath(repoRoot);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, "companions: []\n", "utf8");

  if (companionConfig !== null) writeCompanionConfig(companionPath, companionConfig);

  writeProjectionPair(repoRoot, {
    stamp: "stamp",
    projection: {
      version: "0.18.5",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme-app",
      wrapperBinPath: "/install/mate/wrappers/bin",
      reactDoctorBinPath: "/install/mate/node_modules/.bin/react-doctor",
      graphifyOut: path.join(companionPath, ".graphify", "acme-app", "graphify-out"),
    },
  });
  return { root, repoRoot, companionPath };
}

function writeCompanionConfig(companionPath: string, config: string): void {
  const configPath = companionFrameworkConfigPath(companionPath);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, config, "utf8");
}

function contextOf(dir: string) {
  const result = resolveSessionContext(dir);
  if (!result.ok) throw new Error(`expected a context, got ${result.error.code}`);
  return result.context;
}

describe("resolveSessionContext", () => {
  test("reports the companion, repository and policy of a wrapped repository", () => {
    const { repoRoot, companionPath } = wrappedRepo();

    expect(contextOf(repoRoot)).toEqual({
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme-app",
      policyJson: policyDocument({ allowedAgents: ["claude"], secrets: defaultSecretPolicy() }),
    });
  });

  test("reports the same companion for a folder below the repository root", () => {
    const { repoRoot } = wrappedRepo();
    const below = path.join(repoRoot, "packages", "web");
    fs.mkdirSync(below, { recursive: true });

    expect(contextOf(below)).toEqual(contextOf(repoRoot));
  });

  test("reports the companion's real path when the projection names a link to it", () => {
    const { root, repoRoot, companionPath } = wrappedRepo();
    const link = path.join(root, "acme-link");
    fs.symlinkSync(companionPath, link);
    writeProjectionPair(repoRoot, {
      stamp: "stamp",
      projection: {
        version: "0.18.5",
        companionPath: link,
        repositoryPath: repoRoot,
        repositoryId: "acme-app",
        wrapperBinPath: "/w",
        reactDoctorBinPath: "/r",
        graphifyOut: "/g",
      },
    });

    expect(contextOf(repoRoot).companionPath).toBe(companionPath);
  });

  test("carries a companion's own secret pattern", () => {
    const { repoRoot } = wrappedRepo('secrets:\n  deny: ["*.tfstate"]\n');

    expect(contextOf(repoRoot).policyJson).toBe(
      policyDocument({ allowedAgents: [], secrets: parseSecretsConfig({ deny: ["*.tfstate"] }) }),
    );
  });

  test("carries guardrails off", () => {
    const { repoRoot } = wrappedRepo("secrets:\n  guardrails: false\n");

    expect(JSON.parse(contextOf(repoRoot).policyJson).secrets.guardrails).toBe(false);
  });

  test("keeps the default protections when framework.yaml does not parse", () => {
    const { repoRoot } = wrappedRepo("secrets: [unbalanced\n");

    expect(contextOf(repoRoot).policyJson).toBe(
      policyDocument({ allowedAgents: [], secrets: defaultSecretPolicy() }),
    );
  });

  test("reads the policy anew at each call", () => {
    const { repoRoot, companionPath } = wrappedRepo();
    const before = JSON.parse(contextOf(repoRoot).policyJson);

    writeCompanionConfig(
      companionPath,
      'allowedAgents:\n  - claude\nsecrets:\n  deny: ["*.tfstate"]\n',
    );
    const after = JSON.parse(contextOf(repoRoot).policyJson);

    const patterns = (policy: { secrets: { deny: Array<{ pattern: string }> } }) =>
      policy.secrets.deny.map((rule) => rule.pattern);
    expect(patterns(before)).not.toContain("*.tfstate");
    expect(patterns(after)).toContain("*.tfstate");
  });

  test("answers not-wrapped for a folder no projection covers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-context-bare-"));
    tempRoots.push(dir);

    const result = resolveSessionContext(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not-wrapped");
  });

  test("answers companion-missing when the projected companion folder is gone", () => {
    const { repoRoot, companionPath } = wrappedRepo();
    fs.rmSync(companionPath, { recursive: true, force: true });

    const result = resolveSessionContext(repoRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("companion-missing");
  });

  test("ignores the launch environment", () => {
    const { repoRoot, companionPath } = wrappedRepo();
    const previous = process.env.MATE_ARTIFACT_PATH;
    process.env.MATE_ARTIFACT_PATH = "/elsewhere";
    try {
      expect(contextOf(repoRoot).companionPath).toBe(companionPath);
    } finally {
      if (previous === undefined) delete process.env.MATE_ARTIFACT_PATH;
      else process.env.MATE_ARTIFACT_PATH = previous;
    }
  });
  test("reads allowedAgents from the legacy profiles block, as a launch does", () => {
    const { repoRoot } = wrappedRepo("profiles:\n  default:\n    allowedAgents: [claude]\n");

    expect(JSON.parse(contextOf(repoRoot).policyJson).allowedAgents).toEqual(["claude"]);
  });
});

describe("sessionContextReply", () => {
  test("puts the protocol beside a context", () => {
    const { repoRoot } = wrappedRepo();
    const result = resolveSessionContext(repoRoot);

    expect(sessionContextReply(result)).toEqual({
      protocol: SESSION_CONTEXT_PROTOCOL,
      ...contextOf(repoRoot),
    });
    expect(SESSION_CONTEXT_PROTOCOL).toBe(1);
  });

  test("puts the protocol beside an error, with no companion or policy", () => {
    const reply = sessionContextReply({
      ok: false,
      error: { code: "not-wrapped", message: "no projection" },
    });

    expect(reply).toEqual({
      protocol: 1,
      error: { code: "not-wrapped", message: "no projection" },
    });
  });
});
