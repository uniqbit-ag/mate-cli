import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { companionFrameworkConfigPath } from "./policy";
import { checkSecretAccess, shellWords, type SecretGuardScope } from "./secret-guard";

const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");

const tempRoots: string[] = [];

function scope(config?: string): SecretGuardScope {
  const companionPath = fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-"));
  tempRoots.push(companionPath);
  if (config !== undefined) {
    const configPath = companionFrameworkConfigPath(companionPath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, config, "utf8");
  }
  return {
    companionPath,
    isCompanionPath: (filePath) => filePath.startsWith(companionPath),
  };
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("shellWords", () => {
  test("splits on operators and redirects, keeping quoted strings whole", () => {
    expect(shellWords(`echo TOKEN=x >>.env && cat 'a b' "c" | tee -a out.log`)).toEqual([
      "echo",
      "TOKEN=x",
      ".env",
      "cat",
      "a b",
      "c",
      "tee",
      "-a",
      "out.log",
    ]);
  });

  test("skips heredoc bodies", () => {
    expect(shellWords("cat <<'EOF' > note.md\nsee .env\nEOF\nls")).toEqual([
      "cat",
      "note.md",
      "ls",
    ]);
  });
});

describe("checkSecretAccess: file tools", () => {
  test("blocks reading .env and names the path and the switch", async () => {
    const refusal = await checkSecretAccess({ kind: "read", paths: ["acme/.env"] }, scope());
    expect(refusal).toContain("acme/.env");
    expect(refusal).toContain("secrets");
  });

  test("blocks writing .env.local", async () => {
    const refusal = await checkSecretAccess(
      { kind: "write", writes: [{ path: "acme/.env.local", content: "KEY=1\n" }] },
      scope(),
    );
    expect(refusal).toContain("acme/.env.local");
    expect(refusal).not.toContain("KEY=1");
  });

  test("lets the example file through", async () => {
    expect(await checkSecretAccess({ kind: "read", paths: ["acme/.env.example"] }, scope())).toBe(
      null,
    );
  });

  test("allows everything after an opt-out", async () => {
    const optedOut = scope("secrets:\n  guardrails: false\n");
    expect(await checkSecretAccess({ kind: "read", paths: ["acme/.env"] }, optedOut)).toBe(null);
  });

  test("enforces an extra deny pattern from config", async () => {
    const extra = scope('secrets:\n  deny: ["config/master.key.enc"]\n');
    expect(
      await checkSecretAccess({ kind: "read", paths: ["/r/config/master.key.enc"] }, extra),
    ).not.toBe(null);
  });
});

describe("checkSecretAccess: shell commands", () => {
  test.each(["cat acme/.env", "source .env", "cp .env backup", "echo TOKEN=x >> .env"])(
    "blocks %s",
    async (command) => {
      expect(await checkSecretAccess({ kind: "shell", command }, scope())).not.toBe(null);
    },
  );

  test.each([
    "cat .env.example",
    "diff .env.example .env.sample",
    'git commit -m "ignore .env files"',
    "ls src",
  ])("allows %s", async (command) => {
    expect(await checkSecretAccess({ kind: "shell", command }, scope())).toBe(null);
  });

  test("checks the value of a --flag=path word", async () => {
    expect(
      await checkSecretAccess({ kind: "shell", command: "docker run --env-file=.env x" }, scope()),
    ).not.toBe(null);
  });
});

describe("checkSecretAccess: searches", () => {
  test("blocks a search inside a secret file", async () => {
    expect(
      await checkSecretAccess({ kind: "search", paths: ["acme/.env"], globs: [""] }, scope()),
    ).toContain("acme/.env");
  });

  test("blocks a search whose glob is aimed at secret files", async () => {
    expect(
      await checkSecretAccess({ kind: "search", paths: ["acme"], globs: [".env*"] }, scope()),
    ).toContain(".env*");
  });

  test("lets an ordinary search through", async () => {
    expect(
      await checkSecretAccess({ kind: "search", paths: ["acme/src"], globs: ["*.ts"] }, scope()),
    ).toBe(null);
    expect(
      await checkSecretAccess(
        { kind: "search", paths: ["acme/.env.example"], globs: [""] },
        scope(),
      ),
    ).toBe(null);
  });
});

describe("checkSecretAccess: companion content scan", () => {
  test("blocks a companion write containing a token, naming the rule but not the token", async () => {
    const guarded = scope();
    const target = path.join(guarded.companionPath, "notes", "design.md");
    const refusal = await checkSecretAccess(
      { kind: "write", writes: [{ path: target, content: `token: ${GITHUB_TOKEN}\n` }] },
      guarded,
    );
    expect(refusal).toContain("@secretlint/secretlint-rule-github");
    expect(refusal).toContain(target);
    expect(refusal).not.toContain(GITHUB_TOKEN);
  });

  test("lets a clean companion write through", async () => {
    const guarded = scope();
    const target = path.join(guarded.companionPath, "notes", "design.md");
    expect(
      await checkSecretAccess(
        { kind: "write", writes: [{ path: target, content: "Set GITHUB_TOKEN yourself.\n" }] },
        guarded,
      ),
    ).toBe(null);
  });

  test("does not scan product code writes", async () => {
    let scanned = false;
    const refusal = await checkSecretAccess(
      { kind: "write", writes: [{ path: "/repo/src/app.ts", content: GITHUB_TOKEN }] },
      scope(),
      {
        scan: async () => {
          scanned = true;
          return [];
        },
      },
    );
    expect(refusal).toBe(null);
    expect(scanned).toBe(false);
  });

  test("a scanner error blocks the write", async () => {
    const guarded = scope();
    const refusal = await checkSecretAccess(
      {
        kind: "write",
        writes: [{ path: path.join(guarded.companionPath, "a.md"), content: "x" }],
      },
      guarded,
      {
        scan: async () => {
          throw new Error("engine exploded");
        },
      },
    );
    expect(refusal).toContain("could not be scanned");
  });
});
