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

  test('inside double quotes a backslash goes only before $ ` " \\ or a newline, as in Bash', () => {
    expect(shellWords('cat "pub\\lic/server.key"')).toEqual(["cat", "pub\\lic/server.key"]);
    expect(shellWords('echo "a\\$b" "c\\`d" "e\\"f" "g\\\\h"')).toEqual([
      "echo",
      "a$b",
      "c`d",
      'e"f',
      "g\\h",
    ]);
    expect(shellWords("cat pub\\lic 'pub\\lic'")).toEqual(["cat", "public", "pub\\lic"]);
  });

  test("a comment is read like any other text: the secret check errs toward refusing", () => {
    expect(shellWords("git status # leave server.key alone")).toEqual([
      "git",
      "status",
      "#",
      "leave",
      "server.key",
      "alone",
    ]);
    expect(shellWords("true;# .env\ncat x")).toContain(".env");
  });

  test("each line is read on its own, and the whole command once more; the words of both count", () => {
    // A quote the reader misjudges cannot carry over into the next line.
    expect(shellWords("echo 'x\ncat .env")).toContain(".env");
    // A quote that spans lines in Bash is read whole too.
    expect(shellWords('echo "x\n# " ; cat .env')).toContain(".env");
    expect(shellWords("echo 'a\nb' c")).toEqual(expect.arrayContaining(["echo", "a\nb", "c"]));
  });

  test("a backslash before a newline joins the lines, inside double quotes or out", () => {
    expect(shellWords('echo "a\\\nb" se\\\ncret')).toEqual(
      expect.arrayContaining(["echo", "ab", "secret"]),
    );
  });

  test("ANSI-C quoting: inside $'…' a backslash escapes the next character", () => {
    expect(shellWords("printf %s $'it\\'s'; cat .env")).toEqual([
      "printf",
      "%s",
      "it's",
      "cat",
      ".env",
    ]);
    expect(shellWords("cat $'.e\\x6ev' $'\\056env' a$'b'c")).toEqual([
      "cat",
      ".env",
      ".env",
      "abc",
    ]);
    expect(shellWords('cat $".env"')).toEqual(["cat", ".env"]);
  });

  test("a decoded NUL ends the ANSI-C string; the word goes on after its closing quote", () => {
    // Bash 3.2: printf '%s|' $'a\0b'c prints "ac|".
    for (const nul of ["\\0", "\\000", "\\400", "\\x00", "\\u0000", "\\U00000000", "\\c@"]) {
      expect(shellWords(`cat $'.env${nul}ignored'`)).toEqual(["cat", ".env"]);
      expect(shellWords(`printf %s $'a${nul}b'c`)).toEqual(["printf", "%s", "ac"]);
    }
  });
});

describe("the shell secret check errs toward refusing", () => {
  const refused = async (command: string) =>
    (await checkSecretAccess({ kind: "shell", command }, scope())) !== null;

  test("decided: a comment that names a secret file is refused", async () => {
    expect(await refused("git status # leave server.key alone")).toBe(true);
    expect(await refused("git status \\\n# leave server.key alone")).toBe(true);
    expect(await refused("git status # nothing secret here")).toBe(false);
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

  test("its words count, as an unquoted substitution's do", () => {
    expect(shellWords('echo "$(cat a.txt)" "`ls b.txt`"')).toEqual(
      expect.arrayContaining(["cat", "a.txt", "ls", "b.txt"]),
    );
  });

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
    const refusal = await checkSecretAccess({ kind: "read", paths: ["acme/.env"] }, scope());
    expect(refusal).toContain("acme/.env");
    expect(refusal).toContain("secrets");
  });

  test("blocks writing .env.local", async () => {
    const refusal = await checkSecretAccess(
      { kind: "write", writes: [{ path: "acme/.env.local", content: "KEY=1\n", mode: "create" }] },
      scope(),
    );
    expect(refusal).toContain("acme/.env.local");
    expect(refusal).not.toContain("KEY=1");
  });

  test("blocks a differently-cased .Env", async () => {
    expect(await checkSecretAccess({ kind: "read", paths: ["acme/.Env"] }, scope())).toContain(
      "acme/.Env",
    );
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
      {
        kind: "write",
        writes: [{ path: target, content: `token: ${GITHUB_TOKEN}\n`, mode: "create" }],
      },
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
        {
          kind: "write",
          writes: [{ path: target, content: "Set GITHUB_TOKEN yourself.\n", mode: "create" }],
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
        writes: [{ path: "/repo/src/app.ts", content: GITHUB_TOKEN, mode: "create" }],
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
        writes: [{ path: path.join(guarded.companionPath, "a.md"), content: "x", mode: "create" }],
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
