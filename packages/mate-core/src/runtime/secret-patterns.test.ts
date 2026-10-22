import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SECRET_ALLOW_PATTERNS,
  DEFAULT_SECRET_DENY_PATTERNS,
  defaultSecretPolicy,
  globTargetsSecretFiles,
  isSecretFile,
  matchesSecretPattern,
  parseSecretsConfig,
  projectableSecretDenyPatterns,
} from "./secret-patterns";

const defaults = defaultSecretPolicy();

describe("isSecretFile", () => {
  test.each([
    "acme/.env",
    "/Users/me/acme/.env",
    ".env",
    "acme/.env.local",
    "acme/.env.production.local",
    "acme/.npmrc",
    "acme/certs/server.key",
    "acme/certs/server.pem",
    "acme/keystore.p12",
    "acme/keystore.pfx",
    "home/.ssh/id_rsa",
    "home/.ssh/id_ed25519",
    "home/.netrc",
    "home/.pgpass",
  ])("%s is a secret file", (filePath) => {
    expect(isSecretFile(filePath, defaults)).toBe(true);
  });

  test.each([
    "acme/.env.example",
    "acme/.env.sample",
    "acme/.env.template",
    "acme/.env.dist",
    "acme/src/env.ts",
    "acme/.envrc.md",
    "acme/docs/keys.md",
    "acme/id_rsa.pub",
    "",
  ])("%s is not a secret file", (filePath) => {
    expect(isSecretFile(filePath, defaults)).toBe(false);
  });

  test("an allow match wins over a deny match", () => {
    expect(matchesSecretPattern("acme/.env.example", DEFAULT_SECRET_DENY_PATTERNS)).toBe(true);
    expect(isSecretFile("acme/.env.example", defaults)).toBe(false);
  });

  test("patterns with a slash match on segment boundaries of the path", () => {
    const policy = parseSecretsConfig({ deny: ["config/master.key.enc"] });
    expect(isSecretFile("/repo/config/master.key.enc", policy)).toBe(true);
    expect(isSecretFile("/repo/myconfig/master.key.enc", policy)).toBe(false);
  });

  test("normalizes Windows separators", () => {
    expect(isSecretFile("acme\\certs\\server.key", defaults)).toBe(true);
  });
});

describe("parseSecretsConfig", () => {
  test("absent or malformed block yields the defaults with guardrails active", () => {
    for (const value of [undefined, null, "off", 3, []]) {
      expect(parseSecretsConfig(value)).toEqual(defaults);
    }
    expect(defaults).toEqual({
      guardrails: true,
      deny: [...DEFAULT_SECRET_DENY_PATTERNS],
      allow: [...DEFAULT_SECRET_ALLOW_PATTERNS],
    });
  });

  test("only an explicit false disables guardrails", () => {
    expect(parseSecretsConfig({ guardrails: false }).guardrails).toBe(false);
    expect(parseSecretsConfig({ guardrails: "false" }).guardrails).toBe(true);
    expect(parseSecretsConfig({ guardrails: 0 }).guardrails).toBe(true);
  });

  test("extra patterns add to the defaults and never replace them", () => {
    const policy = parseSecretsConfig({ deny: ["*.secret", 4], allow: [".env.test"] });
    expect(policy.deny).toEqual([...DEFAULT_SECRET_DENY_PATTERNS, "*.secret"]);
    expect(policy.allow).toEqual([...DEFAULT_SECRET_ALLOW_PATTERNS, ".env.test"]);
    expect(isSecretFile("acme/.env.test", policy)).toBe(false);
    expect(isSecretFile("acme/.env", policy)).toBe(true);
    expect(isSecretFile("acme/vault.secret", policy)).toBe(true);
  });
});

describe("projectableSecretDenyPatterns", () => {
  const projectable = projectableSecretDenyPatterns();

  test("never matches an allow-listed file", () => {
    for (const allowed of DEFAULT_SECRET_ALLOW_PATTERNS) {
      expect(matchesSecretPattern(`acme/${allowed}`, projectable)).toBe(false);
    }
  });

  test("replaces .env.* with the common environment files", () => {
    expect(projectable).not.toContain(".env.*");
    for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
      expect(matchesSecretPattern(`acme/${file}`, projectable)).toBe(true);
    }
  });

  test("keeps every default that can't hit an allowed file", () => {
    for (const pattern of DEFAULT_SECRET_DENY_PATTERNS.filter((p) => p !== ".env.*")) {
      expect(projectable).toContain(pattern);
    }
  });
});

describe("globTargetsSecretFiles", () => {
  test.each([".env", ".env*", ".env.*", "**/.env", "*.key", "*.pem", "id_rsa", ".npmrc"])(
    "%s is aimed at secret files",
    (glob) => {
      expect(globTargetsSecretFiles(glob, defaults)).toBe(true);
    },
  );

  test.each(["", "*", "**/*", "*.ts", "*.md", ".env.example", "src/**"])("%s is not", (glob) => {
    expect(globTargetsSecretFiles(glob, defaults)).toBe(false);
  });

  test("follows the policy's extra patterns", () => {
    const policy = parseSecretsConfig({ deny: ["*.secret"], allow: [".npmrc"] });
    expect(globTargetsSecretFiles("*.secret", policy)).toBe(true);
    expect(globTargetsSecretFiles(".npmrc", policy)).toBe(false);
  });
});
