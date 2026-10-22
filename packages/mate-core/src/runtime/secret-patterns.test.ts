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
  secretRule,
  secretRules,
  type SecretPolicy,
  type SecretRule,
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

  test("`**` crosses folder names that hold a line break", () => {
    const policy = parseSecretsConfig({ deny: ["config/**/prod.yaml", "vault/**"] });
    expect(isSecretFile("config/eu\nwest/prod.yaml", policy)).toBe(true);
    expect(isSecretFile("vault/a\nb/token.txt", policy)).toBe(true);
  });

  test("normalizes Windows separators", () => {
    expect(isSecretFile("acme\\certs\\server.key", defaults)).toBe(true);
    expect(isSecretFile("notes\\.env", defaults)).toBe(true);
  });
});

describe("letter case", () => {
  test.each(["notes/.ENV", "keys/ID_RSA", ".Env", "certs/Prod.KEY", "acme/.ENV.Local"])(
    "%s is a secret file",
    (filePath) => {
      expect(isSecretFile(filePath, defaults)).toBe(true);
    },
  );

  test("a differently-cased allowed file stays allowed", () => {
    expect(isSecretFile(".ENV.EXAMPLE", defaults)).toBe(false);
  });

  test("a companion pattern with a folder ignores case in every segment", () => {
    const policy = parseSecretsConfig({ deny: ["config/**/prod.yaml"] });
    expect(isSecretFile("Config/eu/PROD.yaml", policy)).toBe(true);
  });
});

describe("secretRule", () => {
  test("a slash-free pattern is tested against the file name", () => {
    expect(secretRule(".env.*")).toEqual({
      pattern: ".env.*",
      source: "^\\.env\\.[^/]*$",
      flags: "i",
      subject: "name",
    });
  });

  test("a pattern with a slash is tested against the path", () => {
    expect(secretRule("config/**/prod.yaml")).toMatchObject({
      pattern: "config/**/prod.yaml",
      flags: "i",
      subject: "path",
    });
  });

  test("a leading slash does not make a name pattern a path pattern", () => {
    expect(secretRule("/.npmrc").subject).toBe("name");
  });
});

/**
 * What a consumer outside mate-core does with the rules: build each regular
 * expression from its source and flags, and test the subject the rule names.
 */
function evaluate(rules: readonly SecretRule[], filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized) return false;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return rules.some((rule) =>
    new RegExp(rule.source, rule.flags).test(rule.subject === "name" ? name : normalized),
  );
}

describe("secretRules", () => {
  test("carries the policy's guardrails flag and one rule per pattern", () => {
    const policy = parseSecretsConfig({ guardrails: false, deny: ["*.tfstate"] });
    const rules = secretRules(policy);
    expect(rules.guardrails).toBe(false);
    expect(rules.deny.map((rule) => rule.pattern)).toEqual(policy.deny);
    expect(rules.allow.map((rule) => rule.pattern)).toEqual(policy.allow);
  });

  const policies: [string, SecretPolicy][] = [
    ["defaults", defaults],
    [
      "companion patterns",
      parseSecretsConfig({
        deny: ["*.tfstate", "config/**/prod.yaml", "/secrets/**", "vault?.json"],
        allow: [".env.test", "config/**/prod.example.yaml"],
      }),
    ],
  ];
  const paths = [
    ".env",
    "notes/.ENV",
    "notes\\.env",
    "acme/.env.example",
    ".ENV.EXAMPLE",
    "acme/.env.test",
    "keys/ID_RSA",
    "keys/id_rsa.pub",
    "certs/server.KEY",
    "infra/acme.tfstate",
    "infra/acme.TFSTATE",
    "config/prod.yaml",
    "Config/eu/PROD.yaml",
    "config/eu/prod.example.yaml",
    "myconfig/prod.yaml",
    "secrets/token.txt",
    "repo/secrets/deep/token.txt",
    "vault1.json",
    "vault12.json",
    "src/env.ts",
    "README.md",
    "docs/",
    "",
  ];

  for (const [label, policy] of policies) {
    test.each(paths)(`agree with isSecretFile for %p under ${label}`, (filePath) => {
      const rules = secretRules(policy);
      const portable = evaluate(rules.deny, filePath) && !evaluate(rules.allow, filePath);
      expect(portable).toBe(isSecretFile(filePath, policy));
    });
  }

  test("survive a JSON round trip unchanged", () => {
    const rules = secretRules(defaults);
    expect(JSON.parse(JSON.stringify(rules))).toEqual(rules);
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

  test("keeps the pattern text that runtimes match themselves", () => {
    expect(projectable).toEqual([
      ".env",
      ".env.local",
      ".env.development",
      ".env.production",
      ".env.test",
      ".env.*.local",
      "*.pem",
      "*.key",
      "*.p12",
      "*.pfx",
      "id_rsa",
      "id_ecdsa",
      "id_ed25519",
      ".netrc",
      ".pgpass",
      ".npmrc",
    ]);
  });

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
