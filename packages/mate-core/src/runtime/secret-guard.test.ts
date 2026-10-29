import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { companionFrameworkConfigPath } from "./policy";
import { checkSecretAccess, shellWords, type SecretTarget, type SecretWrite } from "./secret-guard";

const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");

const tempRoots: string[] = [];

/** A companion, optionally with a `framework.yaml`; the secret check reads its policy there. */
function scope(config?: string): string {
  const companionPath = fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-"));
  tempRoots.push(companionPath);
  if (config !== undefined) {
    const configPath = companionFrameworkConfigPath(companionPath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, config, "utf8");
  }
  return companionPath;
}

/** A path as the Tool Guard resolves it, with nothing at it: only its name is judged. */
const target = (filePath: string): SecretTarget => ({
  path: filePath,
  landing: filePath,
  exists: false,
});

const write = (filePath: string, content: string, companion: boolean): SecretWrite => ({
  ...target(filePath),
  content,
  companion,
});

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the shell secret check errs toward refusing", () => {
  const refused = async (command: string) =>
    (await checkSecretAccess({ kind: "shell", command }, scope())) !== null;

  test("decided: a comment that names a secret file is refused", async () => {
    expect(await refused("git status # leave server.key alone")).toBe(true);
    expect(await refused("git status \\\n# leave server.key alone")).toBe(true);
    expect(await refused("git status # nothing secret here")).toBe(false);
  });

  test("each line is read on its own and the whole command once more", async () => {
    // A quote the reader misjudges cannot carry over into the next line.
    expect(await refused("echo 'x\ncat .env")).toBe(true);
    // A quote that spans lines in Bash is read whole too.
    expect(await refused('echo "x\n# " ; cat .env')).toBe(true);
  });

  test("a secret read after $'…' with an escaped quote is refused, on the same line or the next", async () => {
    expect(await refused("printf %s $'it\\'s'; cat .env")).toBe(true);
    expect(await refused("printf %s $'it\\'s';\ncat .env")).toBe(true);
    expect(await refused("printf %s $'it\\'s'\ncat .env")).toBe(true);
  });
});

describe("a substitution inside double quotes is read as a command", () => {
  const refused = async (command: string) =>
    (await checkSecretAccess({ kind: "shell", command }, scope())) !== null;

  test("a secret file named inside it is refused", async () => {
    for (const command of [
      'printf "%s" "$(cat cert.key)"',
      'printf "%s" "`cat cert.key`"',
      'printf "%s" $"$(cat cert.key)"',
      'printf "%s" "$(printf "%s" "$(cat cert.key)")"',
      'printf "%s" "$(cat $\'cert\\x2ekey\')"',
      'printf "%s" "$(cat \'cert.key\')"',
      'printf "%s" "$(echo "`cat cert.key`")"',
      'printf "%s" "`echo \\`cat cert.key\\``"',
      'printf "%s" "$(cat \\\ncert.key)"',
      'printf "%s" "$(\ncat cert.key\n)"',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one command at a time
      expect({ command, refused: await refused(command) }).toEqual({ command, refused: true });
    }
  });

  test("single quotes still make it text", async () => {
    expect(await refused("git commit -m 'see $(cat cert.key)'")).toBe(false);
  });
});

describe("the shared shell reader refuses more, and less only for names Bash never opens", () => {
  const refused = async (command: string) =>
    (await checkSecretAccess({ kind: "shell", command }, scope())) !== null;

  test.each([
    ["a file name joined to a substitution", "cat x.pem$(true)"],
    ["a file name after a quoted substitution", 'cat "$(true)".env'],
    ["an env -S command line", "env -S 'cat .env'"],
    ["a value after a substitution", "docker run --env-file$(true)=.env x"],
  ])("refuses %s", async (_label, command) => {
    expect(await refused(command)).toBe(true);
  });

  test.each([
    ["a folder before a substitution", "cat .env.example$(true)/x"],
    ["a heredoc delimiter inside backticks", "echo `cat <<.env\nbody\n.env\n`"],
    ["a comment's trailing backslash, which joins no line", "true # cert.ke\\\ny"],
    ["a quote opened in a comment", "# it's\nx' cat .env\n'"],
    ["a vertical tab, at which Bash does not split", "cat\v.env"],
  ])("allows %s", async (_label, command) => {
    expect(await refused(command)).toBe(false);
  });
});

describe("a backslash in double quotes names the file Bash opens", () => {
  test("an allow pattern does not cover a file that only matches with the backslash dropped", async () => {
    const allowed = scope('secrets:\n  allow: ["public/**"]\n');
    expect(
      await checkSecretAccess({ kind: "shell", command: 'cat "pub\\lic/server.key"' }, allowed),
    ).toContain("pub\\lic/server.key");
    expect(
      await checkSecretAccess({ kind: "shell", command: 'cat "public/server.key"' }, allowed),
    ).toBeNull();
  });
});

describe("checkSecretAccess: file tools", () => {
  test("blocks reading .env and names the path and the switch", async () => {
    const refusal = await checkSecretAccess(
      { kind: "read", targets: [target("acme/.env")] },
      scope(),
    );
    expect(refusal).toContain("acme/.env");
    expect(refusal).toContain("secrets");
  });

  test("blocks writing .env.local", async () => {
    const refusal = await checkSecretAccess(
      { kind: "write", writes: [write("acme/.env.local", "KEY=1\n", false)] },
      scope(),
    );
    expect(refusal).toContain("acme/.env.local");
    expect(refusal).not.toContain("KEY=1");
  });

  test("blocks a differently-cased .Env", async () => {
    expect(
      await checkSecretAccess({ kind: "read", targets: [target("acme/.Env")] }, scope()),
    ).toContain("acme/.Env");
  });

  test("lets the example file through", async () => {
    expect(
      await checkSecretAccess({ kind: "read", targets: [target("acme/.env.example")] }, scope()),
    ).toBe(null);
  });

  test("allows everything after an opt-out", async () => {
    const optedOut = scope("secrets:\n  guardrails: false\n");
    expect(
      await checkSecretAccess({ kind: "read", targets: [target("acme/.env")] }, optedOut),
    ).toBe(null);
  });

  test("enforces an extra deny pattern from config", async () => {
    const extra = scope('secrets:\n  deny: ["config/master.key.enc"]\n');
    expect(
      await checkSecretAccess(
        { kind: "read", targets: [target("/r/config/master.key.enc")] },
        extra,
      ),
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
      await checkSecretAccess(
        { kind: "search", targets: [target("acme/.env")], globs: [""] },
        scope(),
      ),
    ).toContain("acme/.env");
  });

  test("blocks a search whose glob is aimed at secret files", async () => {
    expect(
      await checkSecretAccess(
        { kind: "search", targets: [target("acme")], globs: [".env*"] },
        scope(),
      ),
    ).toContain(".env*");
  });

  test("lets an ordinary search through", async () => {
    expect(
      await checkSecretAccess(
        { kind: "search", targets: [target("acme/src")], globs: ["*.ts"] },
        scope(),
      ),
    ).toBe(null);
    expect(
      await checkSecretAccess(
        { kind: "search", targets: [target("acme/.env.example")], globs: [""] },
        scope(),
      ),
    ).toBe(null);
  });
});

describe("checkSecretAccess: companion content scan", () => {
  test("blocks a companion write containing a token, naming the rule but not the token", async () => {
    const guarded = scope();
    const file = path.join(guarded, "notes", "design.md");
    const refusal = await checkSecretAccess(
      {
        kind: "write",
        writes: [write(file, `token: ${GITHUB_TOKEN}\n`, true)],
      },
      guarded,
    );
    expect(refusal).toContain("@secretlint/secretlint-rule-github");
    expect(refusal).toContain(file);
    expect(refusal).not.toContain(GITHUB_TOKEN);
  });

  test("lets a clean companion write through", async () => {
    const guarded = scope();
    const file = path.join(guarded, "notes", "design.md");
    expect(
      await checkSecretAccess(
        {
          kind: "write",
          writes: [write(file, "Set GITHUB_TOKEN yourself.\n", true)],
        },
        guarded,
      ),
    ).toBe(null);
  });

  test("does not scan product code writes", async () => {
    let scanned = false;
    const refusal = await checkSecretAccess(
      {
        kind: "write",
        writes: [write("/repo/src/app.ts", GITHUB_TOKEN, false)],
      },
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
        writes: [write(path.join(guarded, "a.md"), "x", true)],
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

describe("checkSecretAccess: a path that lands on a secret file", () => {
  const landsOnKey = (filePath: string): SecretTarget => ({
    path: filePath,
    landing: "/home/me/.ssh/server.key",
    exists: true,
  });

  test("is refused, naming the path and where it lands", async () => {
    const refusal = await checkSecretAccess(
      { kind: "read", targets: [landsOnKey("/repo/notes.txt")] },
      scope(),
    );
    expect(refusal).toContain("/repo/notes.txt");
    expect(refusal).toContain("lands in: /home/me/.ssh/server.key");
  });

  test("counts only when something sits at the path", async () => {
    const missing = { ...landsOnKey("/repo/notes.txt"), exists: false };
    expect(await checkSecretAccess({ kind: "read", targets: [missing] }, scope())).toBeNull();
  });

  test("comes after a named secret file and after the content scan", async () => {
    const named = await checkSecretAccess(
      { kind: "search", targets: [landsOnKey("/repo/a.txt"), target("/repo/.env")], globs: [] },
      scope(),
    );
    expect(named).toContain("target: /repo/.env");
    expect(named).not.toContain("lands in");

    const guarded = scope();
    const scanned = await checkSecretAccess(
      {
        kind: "write",
        writes: [
          { ...write(path.join(guarded, "a.md"), "x", false), ...landsOnKey("/repo/a.md") },
          write(path.join(guarded, "b.md"), "x", true),
        ],
      },
      guarded,
      { scan: async (filePath) => [{ path: filePath, line: 1, ruleId: "rule" }] },
    );
    expect(scanned).toContain("would put a secret into the Companion Repository");
  });

  test("an opt-out allows it", async () => {
    const optedOut = scope("secrets:\n  guardrails: false\n");
    expect(
      await checkSecretAccess({ kind: "read", targets: [landsOnKey("/repo/notes.txt")] }, optedOut),
    ).toBeNull();
  });
});
