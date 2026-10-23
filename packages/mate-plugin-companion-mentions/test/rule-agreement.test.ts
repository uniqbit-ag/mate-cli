/**
 * The mod evaluates the secret rules mate compiles; these tests hold the two
 * to one answer. mate-core is imported here, in tests only: the mod itself
 * never imports it.
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SECRET_ALLOW_PATTERNS,
  DEFAULT_SECRET_DENY_PATTERNS,
  defaultSecretPolicy,
  isSecretFile,
  parseSecretsConfig,
  policyDocument,
  secretRule,
  secretRules,
  type SecretPolicy,
} from "@uniqbit/mate-core/runtime";

import { parsePolicy, secretMatch } from "../claude-plugin/hooks/companion.ts";
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
        const mod = secretMatch(parsed.policy, path) !== undefined;
        const mate = policy.guardrails && isSecretFile(path, policy);
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
