import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  companionFrameworkConfigPath,
  isCapabilityEnabled,
  policyDocument,
  readCompanionPolicy,
  resolveSecretPolicy,
} from "./policy";
import {
  defaultSecretPolicy,
  isSecretFile,
  parseSecretsConfig,
  secretRules,
} from "./secret-patterns";

const tempRoots: string[] = [];

function makeCompanion(contents: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-policy-"));
  tempRoots.push(dir);
  if (contents !== null) {
    const configPath = companionFrameworkConfigPath(dir);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, contents, "utf8");
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readCompanionPolicy", () => {
  test("reads allowed agents, enabled capabilities, and git auto mode", () => {
    const companionPath = makeCompanion(
      [
        "type: companion",
        "git: auto",
        "allowedAgents:",
        "  - claude",
        "  - opencode",
        "capabilities:",
        "  - name: graphify",
        "  - name: openspec",
        "",
      ].join("\n"),
    );

    expect(readCompanionPolicy(companionPath)).toEqual({
      allowedAgents: ["claude", "opencode"],
      enabledCapabilities: ["graphify", "openspec"],
      gitAutoMode: true,
      secrets: defaultSecretPolicy(),
    });
  });

  test("reflects a capability toggle immediately, with no projection involved", () => {
    const companionPath = makeCompanion("capabilities:\n  - name: react-doctor\n");
    expect(isCapabilityEnabled(readCompanionPolicy(companionPath), "react-doctor")).toBe(true);

    fs.writeFileSync(companionFrameworkConfigPath(companionPath), "capabilities: []\n", "utf8");
    expect(isCapabilityEnabled(readCompanionPolicy(companionPath), "react-doctor")).toBe(false);
  });

  test("yields an inert policy for a missing, empty, or unparseable companion config", () => {
    const inert = {
      allowedAgents: [],
      enabledCapabilities: [],
      gitAutoMode: false,
      secrets: defaultSecretPolicy(),
    };
    expect(readCompanionPolicy(makeCompanion(null))).toEqual(inert);
    expect(readCompanionPolicy(makeCompanion(""))).toEqual(inert);
    expect(readCompanionPolicy(makeCompanion("[unbalanced\n"))).toEqual(inert);
    expect(readCompanionPolicy(makeCompanion("allowedAgents: nope\ncapabilities: 3\n"))).toEqual(
      inert,
    );
  });

  test("treats any git mode other than auto as disabled", () => {
    expect(readCompanionPolicy(makeCompanion("git: manual\n")).gitAutoMode).toBe(false);
  });

  test("reads the config where the companion path lands, following a link before `..`", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "companion-policy-link-")));
    tempRoots.push(root);
    const real = path.join(root, "outside", "companion");
    const decoy = path.join(root, "companion");
    fs.mkdirSync(path.join(root, "outside", "sub"), { recursive: true });
    fs.symlinkSync(path.join(root, "outside", "sub"), path.join(root, "forward"));
    for (const [dir, config] of [
      [real, "git: auto\nsecrets:\n  deny: [private.txt]\n"],
      [decoy, "secrets:\n  guardrails: false\n"],
    ]) {
      fs.mkdirSync(path.join(dir, ".mate", "config"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".mate", "config", "framework.yaml"), config, "utf8");
    }
    const configured = `${path.join(root, "forward")}/../companion`;

    // Read as the kernel opens it; `fs.realpathSync` would normalise first.
    expect(fs.readFileSync(companionFrameworkConfigPath(configured), "utf8")).toBe(
      fs.readFileSync(path.join(real, ".mate", "config", "framework.yaml"), "utf8"),
    );
    const policy = readCompanionPolicy(configured);
    expect(policy.gitAutoMode).toBe(true);
    expect(policy.secrets.guardrails).toBe(true);
    expect(isSecretFile("private.txt", resolveSecretPolicy(configured))).toBe(true);
  });
});

describe("resolveSecretPolicy", () => {
  test("an absent secrets block keeps guardrails on with the defaults", () => {
    expect(resolveSecretPolicy(makeCompanion("type: companion\n"))).toEqual(defaultSecretPolicy());
  });

  test("an explicit opt-out disables guardrails", () => {
    const companionPath = makeCompanion("secrets:\n  guardrails: false\n");
    expect(resolveSecretPolicy(companionPath).guardrails).toBe(false);
  });

  test("an extra allow pattern exempts a file without touching the defaults", () => {
    const policy = resolveSecretPolicy(makeCompanion('secrets:\n  allow: [".env.test"]\n'));
    expect(isSecretFile("acme/.env.test", policy)).toBe(false);
    expect(isSecretFile("acme/.env", policy)).toBe(true);
  });

  test("an unparseable or missing config fails safe", () => {
    expect(resolveSecretPolicy(makeCompanion("secrets: [unbalanced\n"))).toEqual(
      defaultSecretPolicy(),
    );
    expect(resolveSecretPolicy(makeCompanion(null)).guardrails).toBe(true);
  });

  test("reads the block live, so a toggle applies on the next call", () => {
    const companionPath = makeCompanion("type: companion\n");
    expect(resolveSecretPolicy(companionPath).guardrails).toBe(true);
    fs.writeFileSync(
      companionFrameworkConfigPath(companionPath),
      "secrets: { guardrails: false }\n",
    );
    expect(resolveSecretPolicy(companionPath).guardrails).toBe(false);
  });
});

describe("policyDocument", () => {
  test("carries the allowed agents and the compiled secret rules", () => {
    const secrets = defaultSecretPolicy();
    expect(JSON.parse(policyDocument({ allowedAgents: ["claude"], secrets }))).toEqual({
      allowedAgents: ["claude"],
      secrets: secretRules(secrets),
    });
  });

  test("adds a companion's own deny pattern beside the defaults", () => {
    const document = JSON.parse(
      policyDocument({ allowedAgents: [], secrets: parseSecretsConfig({ deny: ["*.tfstate"] }) }),
    );
    const patterns = document.secrets.deny.map((rule: { pattern: string }) => rule.pattern);
    expect(patterns).toContain(".env");
    expect(patterns).toContain("*.tfstate");
  });

  test("carries an opt-out", () => {
    const secrets = parseSecretsConfig({ guardrails: false });
    expect(JSON.parse(policyDocument({ allowedAgents: [], secrets })).secrets.guardrails).toBe(
      false,
    );
  });

  test("stays small with the default patterns", () => {
    const document = policyDocument({
      allowedAgents: ["claude", "opencode"],
      secrets: defaultSecretPolicy(),
    });
    expect(document.length).toBeLessThan(4096);
  });
});
