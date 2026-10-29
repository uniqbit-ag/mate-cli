/**
 * The mod evaluates the secret rules mate compiles; these tests hold the two
 * to one answer. mate-core is imported here, in tests only: the mod itself
 * never imports it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_SECRET_ALLOW_PATTERNS,
  DEFAULT_SECRET_DENY_PATTERNS,
  defaultSecretPolicy,
  isSecretFile,
  parseSecretsConfig,
  companionFrameworkConfigPath,
  policyDocument,
  repoLocalRegistryPath,
  resolveSessionContext,
  secretRule,
  secretRules,
  sessionContextReply,
  writeProjectionPair,
  type SecretPolicy,
} from "@uniqbit/mate-core/runtime";

import { parseContext, parsePolicy, secretMatch } from "../claude-plugin/hooks/companion.ts";
import { DEFAULT_ALLOW, DEFAULT_DENY, RULES, policyJson } from "../claude-plugin/tests/policy.ts";

const policies: [string, SecretPolicy][] = [
  ["the defaults", defaultSecretPolicy()],
  [
    "companion patterns",
    parseSecretsConfig({
      deny: ["*.tfstate", "config/**/prod.yaml", "/secrets/**", "vault?.json"],
      allow: [".env.test", "config/**/prod.example.yaml"],
    }),
  ],
  ["guardrails off", parseSecretsConfig({ guardrails: false })],
];

const paths = [
  ".env",
  ".Env",
  "notes/.ENV",
  "notes\\.env",
  "notes\\sub\\.env.local",
  "secrets\\token.txt",
  ".env.example",
  ".ENV.EXAMPLE",
  ".env.test",
  "keys/id_rsa",
  "keys/ID_RSA",
  "keys/id_rsa.pub",
  "certs/server.KEY",
  "certs/",
  "infra/acme.tfstate",
  "infra/acme.TFSTATE",
  "config/prod.yaml",
  "Config/eu/PROD.yaml",
  "config/eu/prod.example.yaml",
  "myconfig/prod.yaml",
  "secrets/token.txt",
  "secrets/deep/token.txt",
  "vault1.json",
  "vault12.json",
  "src/env.ts",
  "README.md",
  "",
];

describe("the mod and mate agree on secret files", () => {
  for (const [label, policy] of policies) {
    test(`under ${label}`, () => {
      const parsed = parsePolicy(policyDocument({ allowedAgents: ["claude"], secrets: policy }));
      if ("error" in parsed) throw new Error(parsed.error);
      for (const path of paths) {
        // The mod is handed `/`-separated paths, in which a `\\` is part of a name.
        const mod = secretMatch(parsed.policy, path) !== undefined;
        const mate = policy.guardrails && isSecretFile(path, policy, { windows: false });
        expect({ path, secret: mod }).toEqual({ path, secret: mate });
      }
    });
  }
});

describe("the hook suites' policy fixture", () => {
  test("holds mate's default patterns, in mate's order", () => {
    expect(DEFAULT_DENY).toEqual([...DEFAULT_SECRET_DENY_PATTERNS]);
    expect(DEFAULT_ALLOW).toEqual([...DEFAULT_SECRET_ALLOW_PATTERNS]);
  });

  test("holds each rule as mate compiles it", () => {
    for (const [pattern, rule] of Object.entries(RULES)) {
      expect(rule).toEqual(secretRule(pattern));
    }
  });

  test("is the policy document mate writes", () => {
    const policy = parseSecretsConfig({ guardrails: false, deny: ["*.tfstate"] });
    expect(JSON.parse(policyJson({ guardrails: false, deny: ["*.tfstate"] }))).toEqual({
      allowedAgents: ["claude"],
      secrets: secretRules(policy),
    });
  });
});

const tempRoots: string[] = [];
afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A wrapped repository whose companion's `framework.yaml` holds `config`. */
function wrappedRepo(config: string): { repoRoot: string; companionPath: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mentions-context-")));
  tempRoots.push(root);
  const repoRoot = path.join(root, "acme-app");
  const companionPath = path.join(root, "acme");
  fs.mkdirSync(path.dirname(companionFrameworkConfigPath(companionPath)), { recursive: true });
  fs.writeFileSync(companionFrameworkConfigPath(companionPath), config, "utf8");
  fs.mkdirSync(path.dirname(repoLocalRegistryPath(repoRoot)), { recursive: true });
  fs.writeFileSync(repoLocalRegistryPath(repoRoot), "companions: []\n", "utf8");
  writeProjectionPair(repoRoot, {
    stamp: "stamp",
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme-app",
      wrapperBinPath: "/w",
      reactDoctorBinPath: "/r",
      graphifyOut: "/g",
    },
  });
  return { repoRoot, companionPath };
}

describe("the mod reads what mate session context prints", () => {
  const configs: [string, string, SecretPolicy][] = [
    ["the defaults", "allowedAgents: [claude]\n", defaultSecretPolicy()],
    [
      "companion patterns",
      'secrets:\n  deny: ["*.tfstate", "/secrets/**"]\n  allow: [".env.test"]\n',
      parseSecretsConfig({ deny: ["*.tfstate", "/secrets/**"], allow: [".env.test"] }),
    ],
    [
      "guardrails off",
      "secrets:\n  guardrails: false\n",
      parseSecretsConfig({ guardrails: false }),
    ],
  ];

  for (const [label, config, policy] of configs) {
    test(`under ${label}`, () => {
      const { repoRoot, companionPath } = wrappedRepo(config);
      const printed = JSON.stringify(sessionContextReply(resolveSessionContext(repoRoot)));

      const context = parseContext(printed);
      if ("reason" in context) throw new Error(context.reason);
      expect(context.root).toBe(companionPath);
      for (const file of paths) {
        const mod = secretMatch(context.policy, file) !== undefined;
        const mate = policy.guardrails && isSecretFile(file, policy);
        expect({ file, secret: mod }).toEqual({ file, secret: mate });
      }
    });
  }

  test("reads a refusal mate prints as no companion", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mentions-context-bare-"));
    tempRoots.push(dir);
    const printed = JSON.stringify(sessionContextReply(resolveSessionContext(dir)));
    const context = parseContext(printed);
    expect("reason" in context && context.reason).toContain("no mate companion");
  });
});
