import { describe, expect, test } from "bun:test";

import {
  heredocBodies,
  MAX_SHELL_NESTING,
  readShell,
  ShellNestingError,
  writeTargets,
  type ShellCommand,
} from "./shell-reading";

const argv = (command: ShellCommand) => command.argv.map((word) => word.text);
const commands = (text: string) => readShell(text).commands.map(argv);
const words = (text: string) => readShell(text).words.map((word) => word.text);
const comments = (text: string) => readShell(text).comments.map((word) => word.text);
const targets = (text: string) => writeTargets(readShell(text));
/** The text without heredoc bodies, as one string. */
const stripped = (text: string) => readShell(text).lines.join("\n");
const heredocs = (text: string) => readShell(text).commands.map((command) => command.heredocs);

describe("commands", () => {
  test("are split at operators and newlines, in source order, then substitutions depth-first", () => {
    expect(commands("a 1 && b 2 | c; d\ne $(f $(g)) `h`")).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c"],
      ["d"],
      ["e", "$(f $(g))", "`h`"],
      ["f", "$(g)"],
      ["g"],
      ["h"],
    ]);
  });

  test("argv starts after keywords and assignments", () => {
    expect(commands("if X=1 Y+=2 git commit; then ! { tee a; }; fi")).toEqual([
      ["git", "commit"],
      ["tee", "a"],
      ["}"],
      ["fi"],
    ]);
  });

  test("argv starts after wrappers, skipping their option arguments", () => {
    for (const text of [
      "sudo -u bob git commit",
      "sudo --user bob git commit",
      "nice -n 5 git commit",
      "env -u HOME git commit",
      "exec -a name git commit",
      "time -f %e git commit",
      "stdbuf -o0 git commit",
      "xargs -I {} git commit",
      "command nohup git commit",
      "sudo -E -- git commit",
    ]) {
      expect({ text, argv: commands(text)[0] }).toEqual({ text, argv: ["git", "commit"] });
    }
  });

  test("env -S splices its command line in place", () => {
    expect(commands("env -S 'git commit -m x'")).toEqual([["git", "commit", "-m", "x"]]);
    expect(commands("env --split-string='a; tee b'")).toEqual([["a"], ["tee", "b"]]);
  });

  test("a substitution in the name's position comes first, and nothing after it is a wrapper", () => {
    const [command] = readShell("$(true) sudo git commit").commands;
    expect(command.argv[0].opaque).toBe(true);
    expect(argv(command)).toEqual(["$(true)", "sudo", "git", "commit"]);
  });

  test("an array assignment keeps the command position", () => {
    expect(commands("a=() x 1")).toEqual([["x", "1"]]);
    expect(targets("a=(1 2) tee notes.md")).toEqual(["notes.md"]);
  });

  test("a subshell starts a command; a word after its `)` does not", () => {
    expect(commands("(git commit) x")).toEqual([["git", "commit"]]);
  });

  test("a command inside a quoted substitution is read; a quoted command text is not", () => {
    expect(commands('echo "$(git commit -m x)"')).toEqual([
      ["echo", "$(git commit -m x)"],
      ["git", "commit", "-m", "x"],
    ]);
    expect(commands('echo "a && git commit"')).toEqual([["echo", "a && git commit"]]);
  });

  test("bash -c, eval and a script fed to a shell are not read into", () => {
    expect(commands("bash -c 'git commit'")).toEqual([["bash", "-c", "git commit"]]);
    expect(commands("eval 'git commit'")).toEqual([["eval", "git commit"]]);
    expect(commands("bash <<EOF\ngit commit\nEOF")).toEqual([["bash"]]);
  });
});

describe("words", () => {
  test("quotes are removed, escapes applied and $'…' decoded", () => {
    expect(words(`cat 'a b' "c\\$d" e\\ f $'g\\x2eh' "pub\\lic"`)).toEqual([
      "cat",
      "a b",
      "c$d",
      "e f",
      "g.h",
      "pub\\lic",
    ]);
  });

  test("a quote that spans lines keeps one word", () => {
    expect(words("echo 'a\nb' c")).toEqual(["echo", "a\nb", "c"]);
  });

  test("a backslash-newline joins the lines, inside double quotes or out", () => {
    expect(words('echo "a\\\nb" se\\\ncret')).toEqual(["echo", "ab", "secret"]);
  });

  test("a word holding a substitution is opaque; its pieces are the literal runs", () => {
    const opaque = readShell('cat a$(b)c "d`e`f" $(g) x.pem$(true)').words.filter(
      (each) => each.opaque,
    );
    expect(opaque.map(({ text, pieces }) => ({ text, pieces }))).toEqual([
      { text: "a$(b)c", pieces: ["a", "c"] },
      { text: "d`e`f", pieces: ["d", "f"] },
      { text: "$(g)", pieces: [] },
      { text: "x.pem$(true)", pieces: ["x.pem"] },
    ]);
  });

  test("a substitution's words count, and its commands hang off its word", () => {
    const reading = readShell('echo "$(cat a.txt)"');
    expect(reading.words.map((word) => word.text)).toEqual([
      "echo",
      "cat",
      "a.txt",
      "$(cat a.txt)",
    ]);
    expect(reading.words[3].commands.map(argv)).toEqual([["cat", "a.txt"]]);
  });

  test("redirect targets and here-strings are words; a heredoc marker is not", () => {
    expect(words("echo x >>.env 2>err.log <<<here <<'EOF'\nbody\nEOF")).toEqual([
      "echo",
      "x",
      ".env",
      "err.log",
      "here",
    ]);
  });
});

describe("comments", () => {
  test("are read as command text, apart from the words", () => {
    const reading = readShell("git status # leave server.key 'alone\ncat x");
    expect(reading.words.map((word) => word.text)).toEqual(["git", "status", "cat", "x"]);
    expect(reading.comments.map((word) => word.text)).toEqual([
      "#",
      "leave",
      "server.key",
      "alone",
    ]);
  });

  test("keep their # and drop a backslash that would continue the line", () => {
    expect(readShell("#\\=.env").comments.map((word) => word.text)).toEqual(["#=.env"]);
    expect(readShell("# x.pem\\\nls").comments.map((word) => word.text)).toEqual(["#", "x.pem"]);
  });

  test("a # inside a word starts no comment", () => {
    expect(words("echo a#b")).toEqual(["echo", "a#b"]);
  });
});

describe("lines", () => {
  test("are the text without heredoc bodies, split at newlines", () => {
    expect(readShell("cat <<'EOF'\nsee .env\nEOF\nls").lines).toEqual(["cat <<'EOF'", "ls"]);
  });
});

describe("redirects", () => {
  test("carry their operator, target and whether they name a descriptor", () => {
    const [command] = readShell("cmd > a 2>&1 >&- &>> b < c").commands;
    expect(
      command.redirects.map(({ operator, target, descriptor }) => [
        operator,
        target.text,
        descriptor,
      ]),
    ).toEqual([
      [">", "a", false],
      [">&", "1", true],
      [">&", "-", true],
      ["&>>", "b", false],
      ["<", "c", false],
    ]);
  });
});

describe("heredocs", () => {
  test("a command reads its own and those piped into it", () => {
    const reading = readShell(
      "git commit -F - <<A\none\nA\ncat <<B | sort | git commit -F -\ntwo\nB",
    );
    expect(reading.commands.map((command) => command.heredocs)).toEqual([
      ["one"],
      ["two"],
      ["two"],
      ["two"],
    ]);
  });

  test("not those of a command before ; or &&", () => {
    const reading = readShell("cat <<EOF >msg.txt; git commit -F msg.txt\nbody\nEOF");
    expect(reading.commands.map((command) => command.heredocs)).toEqual([["body"], []]);
  });

  test("a heredoc inside a substitution belongs to the command there", () => {
    const reading = readShell("git commit -m \"$(cat <<'EOF'\nbody\nEOF\n)\"");
    const message = reading.commands[0].argv[3];
    expect(message.commands.map((command) => command.heredocs)).toEqual([["body"]]);
  });

  test("inside backticks, after an escape layer", () => {
    const reading = readShell("echo `printf \\$x; cat <<EOF `\nbody\nEOF");
    expect(reading.commands.map((command) => command.heredocs)).toEqual([[], [], ["body"]]);
  });

  test("|& pipes them on", () => {
    expect(heredocs("cat <<A |& sort\none\nA")).toEqual([["one"], ["one"]]);
  });

  test("piped into a group, every command in it reads them, past ; and &&", () => {
    expect(heredocs("cat <<A | { x; y && z; }\none\nA")).toEqual([
      ["one"],
      ["one"],
      ["one"],
      ["one"],
      ["one"],
    ]);
    expect(heredocs("cat <<A | (x; y)\none\nA")).toEqual([["one"], ["one"], ["one"]]);
    expect(heredocs("cat <<A | while read l; do x; done\none\nA")).toEqual([
      ["one"],
      ["one"],
      ["one"],
      ["one"],
    ]);
  });

  test("a group passes what its commands and its input read on to a pipe after it", () => {
    expect(heredocs("{ x; cat <<A; } | y\none\nA").at(-1)).toEqual(["one"]);
    expect(heredocs("(cat <<A; x) | y\none\nA").at(-1)).toEqual(["one"]);
    expect(heredocs("if x; then cat <<A; fi | y\none\nA").at(-1)).toEqual(["one"]);
    expect(heredocs("for f in a; do cat <<A; done | y\none\nA").at(-1)).toEqual(["one"]);
    expect(heredocs("cat <<A | { cat; } | y\none\nA").at(-1)).toEqual(["one"]);
  });

  test("one on a group's closer feeds every command in the group", () => {
    expect(heredocs("while read l; do x; done <<A\none\nA")).toEqual([["one"], ["one"], ["one"]]);
    expect(heredocs("(x; y) <<A\none\nA")).toEqual([["one"], ["one"], ["one"]]);
  });

  test("each body is read once, however many groups pass it on", () => {
    expect(heredocs("cat <<A | { cat; } | { cat; } | { cat; } | y\none\nA").at(-1)).toEqual([
      "one",
    ]);
  });

  test("heredocBodies reads many commands' bodies once each, earlier stages first", () => {
    const reading = readShell("cat <<A | sort <<B\none\nA\ntwo\nB\ncat <<C\nthree\nC");
    expect(heredocBodies(reading.commands)).toEqual(["one", "two", "three"]);
  });

  test("a long pipeline links its bodies instead of copying them per command", () => {
    const stages = 30_000;
    const text = `${"cat <<E | ".repeat(stages)}y\n${Array.from({ length: stages }, (_, i) => `${i}\nE`).join("\n")}`;
    const reading = readShell(text);
    expect(heredocBodies([reading.commands.at(-1) as ShellCommand])).toHaveLength(stages);
  });

  test("a case pattern's ) ends the pattern, not a subshell around the case", () => {
    expect(heredocs("(case x in x) y;; esac) <<A\none\nA")[1]).toEqual(["one"]);
    expect(commands("(case x in (a|b) y;; c) z; esac)")).toEqual([
      ["case", "x"],
      ["y"],
      ["z"],
      ["esac"],
    ]);
  });

  test("after ;; a closer word is a pattern; only esac ends the case", () => {
    expect(
      heredocs("for i in 1; do case $i in done) cat <<A;; esac; done | y\none\nA").at(-1),
    ).toEqual(["one"]);
  });

  test("time may stand before a group", () => {
    expect(heredocs("time { x; } <<A\none\nA")[0]).toEqual(["one"]);
    expect(heredocs("time -p { x; } <<A\none\nA")[0]).toEqual(["one"]);
  });

  test("a quoted or escaped closer is a word, not a closer", () => {
    expect(heredocs("{ '}'; x; } <<A\none\nA")[1]).toEqual(["one"]);
    expect(heredocs("{ \\}; x; } <<A\none\nA")[1]).toEqual(["one"]);
  });

  test("inside a group, not those of a command before ; or a group before it", () => {
    expect(heredocs("{ cat <<A >m; x; }\none\nA")).toEqual([["one"], [], []]);
    expect(heredocs("{ cat <<A; }; x\none\nA")).toEqual([["one"], [], []]);
  });
});

describe("writeTargets", () => {
  test("redirect writes and literal tee operands, in the order written, then substitutions'", () => {
    const text = "tee -a a.md >b.md -- -c.md $(x) && echo >| d.md 2>&1 <> e.md $(cat >f.md)";
    expect(writeTargets(readShell(text))).toEqual([
      "a.md",
      "b.md",
      "-c.md",
      "d.md",
      "e.md",
      "f.md",
    ]);
  });

  test("tee counts only as the command's name, through wrappers and env -S", () => {
    expect(writeTargets(readShell("echo tee a.md"))).toEqual([]);
    expect(writeTargets(readShell("sudo -u bob tee a.md"))).toEqual(["a.md"]);
    expect(writeTargets(readShell("env -S 'tee a.md' >b.md"))).toEqual(["a.md", "b.md"]);
  });
});

describe("nesting", () => {
  const nested = (levels: number) =>
    `${'printf "%s" "$('.repeat(levels)}cat x${')"'.repeat(levels)}`;

  test(`reads ${MAX_SHELL_NESTING} levels and refuses one more`, () => {
    expect(() => readShell(nested(MAX_SHELL_NESTING))).not.toThrow();
    expect(() => readShell(nested(MAX_SHELL_NESTING + 1))).toThrow(ShellNestingError);
  });

  test("the limit covers comments too", () => {
    expect(() => readShell(`# ${"$(".repeat(MAX_SHELL_NESTING + 1)}`)).toThrow(ShellNestingError);
  });

  // Node, which runs the Claude hook, throws RangeError for a call with too many
  // arguments, where Bun does not; this applies Node's limit inside Bun.
  const withNodeArgumentLimit = (read: () => void) => {
    const { push, splice } = Array.prototype;
    const limit = 65_536;
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      if (items.length > limit) throw new RangeError("Maximum call stack size exceeded");
      return push.apply(this, items);
    };
    Array.prototype.splice = function (this: unknown[], ...args: unknown[]) {
      if (args.length > limit) throw new RangeError("Maximum call stack size exceeded");
      return (splice as (...a: unknown[]) => unknown[]).apply(this, args);
    } as typeof splice;
    try {
      read();
    } finally {
      Array.prototype.push = push;
      Array.prototype.splice = splice;
    }
  };

  test("a wide command is read, and one nested too deep after it is refused as such", () => {
    const wide = `echo $(${":;".repeat(125_000)}true)`;
    withNodeArgumentLimit(() => expect(() => readShell(wide)).not.toThrow());
    withNodeArgumentLimit(() =>
      expect(() => readShell(`${wide}; ${nested(MAX_SHELL_NESTING + 1)}`)).toThrow(
        ShellNestingError,
      ),
    );
    const split = `env -S '${"a ".repeat(150_000)}'`;
    withNodeArgumentLimit(() => expect(() => readShell(split)).not.toThrow());
  });

  test("unquoted substitutions count alike", () => {
    let unquoted = "tee notes.md";
    for (let i = 0; i < MAX_SHELL_NESTING - 1; i++) unquoted = `echo $(${unquoted})`;
    expect(targets(unquoted)).toEqual(["notes.md"]);
    unquoted = "true";
    for (let i = 0; i <= MAX_SHELL_NESTING; i++) unquoted = `echo $(${unquoted})`;
    expect(() => readShell(unquoted)).toThrow(ShellNestingError);
  });
});

// Moved from the Tool Guard's and the secret check's tests: what a command names, read once.

describe("words follow Bash's quoting", () => {
  test("operators and redirects separate words; quoted strings stay whole", () => {
    expect(words(`echo TOKEN=x >>.env && cat 'a b' "c" | tee -a out.log`)).toEqual([
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

  test('inside double quotes a backslash goes only before $ ` " \\ or a newline', () => {
    expect(words('cat "pub\\lic/server.key"')).toEqual(["cat", "pub\\lic/server.key"]);
    expect(words('echo "a\\$b" "c\\`d" "e\\"f" "g\\\\h"')).toEqual([
      "echo",
      "a$b",
      "c`d",
      'e"f',
      "g\\h",
    ]);
    expect(words("cat pub\\lic 'pub\\lic'")).toEqual(["cat", "public", "pub\\lic"]);
  });

  test("redirect targets keep the same rules", () => {
    expect(targets('printf x > "co\\mpanion/notes.md"')).toEqual(["co\\mpanion/notes.md"]);
    expect(targets('printf x > "companion\\\\/notes.md"')).toEqual(["companion\\/notes.md"]);
    expect(targets('printf x > "compa\\\nnion/notes.md"')).toEqual(["companion/notes.md"]);
    expect(targets('printf x > "companion/n\\"otes.md"')).toEqual(['companion/n"otes.md']);
    expect(targets('printf x > "companion/\\$x.md"')).toEqual(["companion/$x.md"]);
    expect(targets("printf x > co\\mpanion/notes.md")).toEqual(["companion/notes.md"]);
    expect(targets("printf x > 'co\\mpanion/notes.md'")).toEqual(["co\\mpanion/notes.md"]);
    expect(targets("printf x > compa\\\nnion/notes.md")).toEqual(["companion/notes.md"]);
  });

  test("quoted targets with spaces", () => {
    expect(targets('printf x > "notes dir/handoff.md"')).toEqual(["notes dir/handoff.md"]);
    expect(targets("printf x > 'notes dir/handoff.md'")).toEqual(["notes dir/handoff.md"]);
    expect(targets('printf x >> "a b.md"')).toEqual(["a b.md"]);
  });

  test("ANSI-C quoting: inside $'…' a backslash escapes the next character", () => {
    expect(words("printf %s $'it\\'s'; cat .env")).toEqual(["printf", "%s", "it's", "cat", ".env"]);
    expect(words("cat $'.e\\x6ev' $'\\056env' a$'b'c")).toEqual(["cat", ".env", ".env", "abc"]);
    expect(targets("printf %s $'it\\'s' > plan.md")).toEqual(["plan.md"]);
    expect(targets("printf %s $'it\\'s'\nprintf x > plan.md")).toEqual(["plan.md"]);
    expect(targets("echo \"$(printf %s $'a\\')' > plan.md)\"")).toEqual(["plan.md"]);
    expect(targets("printf x > $'plan.md'")).toEqual(["plan.md"]);
    expect(targets("echo $'> plan.md' > src/a.ts")).toEqual(["src/a.ts"]);
  });

  test("a decoded NUL ends the ANSI-C string; the word goes on after its closing quote", () => {
    // Bash 3.2: printf '%s|' $'a\0b'c prints "ac|".
    for (const nul of ["\\0", "\\000", "\\400", "\\x00", "\\u0000", "\\U00000000", "\\c@"]) {
      expect(words(`cat $'.env${nul}ignored'`)).toEqual(["cat", ".env"]);
      expect(words(`printf %s $'a${nul}b'c`)).toEqual(["printf", "%s", "ac"]);
    }
    expect(targets("printf x > $'notes.md\\0x'")).toEqual(["notes.md"]);
    expect(targets("printf x > $'notes.md\\x00'.txt")).toEqual(["notes.md.txt"]);
  });

  test('$"…" is a double-quoted string', () => {
    expect(words('cat $".env"')).toEqual(["cat", ".env"]);
    expect(targets('printf x > $"README.md"')).toEqual(["README.md"]);
  });
});

describe("redirects as write targets", () => {
  test("descriptor and combined redirects", () => {
    expect(targets("make 2> build-notes.md")).toEqual(["build-notes.md"]);
    expect(targets("make &> build-notes.md")).toEqual(["build-notes.md"]);
    expect(targets("make >| build-notes.md")).toEqual(["build-notes.md"]);
    expect(targets("make 2>&1 > build-notes.md")).toEqual(["build-notes.md"]);
    expect(targets("make > /dev/null 2>&1")).toEqual(["/dev/null"]);
  });

  test("an input redirect and a quoted word are not write targets", () => {
    expect(targets("wc -l < notes.md")).toEqual([]);
    expect(targets('git commit -m "see > notes.md"')).toEqual([]);
    expect(targets("echo notes.md.bak > src/a.ts")).toEqual(["src/a.ts"]);
  });

  test("a read-write redirect writes its target", () => {
    expect(targets("exec 3<> notes.md")).toEqual(["notes.md"]);
  });
});

describe("tee operands", () => {
  test("every operand, with or without options", () => {
    expect(targets("echo x | tee README.md notes.md")).toEqual(["README.md", "notes.md"]);
    expect(targets("echo x | tee -a README.md notes.md")).toEqual(["README.md", "notes.md"]);
    expect(targets("echo x | tee --append README.md notes.md")).toEqual(["README.md", "notes.md"]);
    expect(targets("echo x | tee -i README.md 'my notes.md'")).toEqual([
      "README.md",
      "my notes.md",
    ]);
  });

  test("stop at the next command", () => {
    expect(targets("echo x | tee src/a.ts; cat notes.md")).toEqual(["src/a.ts"]);
    expect(targets("echo x | tee src/a.ts | grep notes.md")).toEqual(["src/a.ts"]);
  });

  test("a descriptor redirect does not end them", () => {
    for (const redirect of ["<&0", "0<&0", "<&-", "2>&1", ">&2", "2>/dev/null", "&>/dev/null"]) {
      expect({ redirect, targets: targets(`printf x | tee ${redirect} notes.md`) }).toEqual({
        redirect,
        targets: redirect.includes("/dev/null") ? ["/dev/null", "notes.md"] : ["notes.md"],
      });
    }
    expect(targets("printf x |& tee notes.md")).toEqual(["notes.md"]);
    expect(targets("printf x | tee 2<>log.txt notes.md")).toEqual(["log.txt", "notes.md"]);
  });

  test("a substitution is one opaque word, and the operands after it are still read", () => {
    for (const command of [
      "printf x | tee $(printf README.md) notes.md",
      "printf x | tee >(cat) notes.md",
      "printf x | tee <(printf x) notes.md",
      "printf x | tee `printf a` notes.md",
      'printf x | tee "$(echo "a b)")" notes.md',
      "printf x | tee $(echo $(echo a) ')') notes.md",
      "printf x | tee a$(echo b)c notes.md",
    ]) {
      expect({ command, targets: targets(command) }).toEqual({ command, targets: ["notes.md"] });
    }
  });

  test("an opaque word is never itself a target", () => {
    expect(targets("printf x > $(echo notes.md)")).toEqual([]);
    expect(targets("printf x | tee `echo notes.md`")).toEqual([]);
    expect(targets("printf x | tee notes$(echo x).md")).toEqual([]);
  });

  test("the commands inside a substitution are read as commands", () => {
    expect(targets("printf x | tee >(cat > notes.md) src/a.ts")).toEqual(["src/a.ts", "notes.md"]);
    expect(targets("echo $(printf x | tee notes.md)")).toEqual(["notes.md"]);
    expect(targets('echo "`printf x > notes.md`"')).toEqual(["notes.md"]);
    expect(targets("echo $(echo $(tee notes.md))")).toEqual(["notes.md"]);
  });

  test("a subshell ends a tee", () => {
    expect(targets("(printf x | tee src/a.ts) notes.md")).toEqual(["src/a.ts"]);
  });

  test("tee as an argument writes nothing", () => {
    for (const command of [
      "grep tee docs/notes.md",
      "ls tee notes.md",
      'printf "%s" "tee" docs/notes.md',
      "echo x | grep -e tee notes.md",
    ]) {
      expect({ command, targets: targets(command) }).toEqual({ command, targets: [] });
    }
  });

  test("tee in command position, after any separator", () => {
    for (const command of [
      "tee notes.md",
      "echo x | tee notes.md",
      "true && tee notes.md",
      "false || tee notes.md",
      "true; tee notes.md",
      "sleep 1 & tee notes.md",
      "true\ntee notes.md",
      "(tee notes.md)",
      "if true; then tee notes.md; fi",
      "{ tee notes.md; }",
      "f() { tee notes.md; }; f",
      "case x in x) tee notes.md;; esac",
      "case x in (x) tee notes.md;; esac",
      "/usr/bin/tee notes.md",
    ]) {
      expect({ command, targets: targets(command) }).toEqual({ command, targets: ["notes.md"] });
    }
    expect(targets("> src/a.ts tee notes.md")).toEqual(["src/a.ts", "notes.md"]);
  });

  test("tee behind assignments and wrappers, their option arguments skipped", () => {
    for (const command of [
      "FOO=1 BAR=2 tee notes.md",
      "sudo tee notes.md",
      "sudo -u root tee notes.md",
      "env FOO=1 tee notes.md",
      "env -i tee notes.md",
      "command tee notes.md",
      "exec tee notes.md",
      "nohup tee notes.md",
      "nice -n 5 tee notes.md",
      "time tee notes.md",
      "stdbuf -oL tee notes.md",
      "echo notes.md | xargs tee notes.md",
      "echo x | xargs -I {} tee notes.md",
      "sudo env FOO=1 nice tee -a notes.md",
      "sudo --user bob tee notes.md",
      "sudo --user=bob tee notes.md",
      "sudo -u bob -g staff --chdir /tmp --host h --prompt p --close-from 3 --other-user x tee notes.md",
      "sudo -ubob tee notes.md",
      "env --unset FOO --chdir /tmp tee notes.md",
      "env -u FOO -C /tmp tee notes.md",
      "nice --adjustment 5 tee notes.md",
      "nice -n5 tee notes.md",
      "stdbuf --output L -e 0 tee notes.md",
      "echo x | xargs --max-args 1 --delimiter , tee notes.md",
      "echo x | xargs -n 1 -P 2 tee notes.md",
      "time -f %e -o out.txt tee notes.md",
      "time --format %e --output out.txt tee notes.md",
      "sudo -- tee notes.md",
      "sudo --some-flag tee notes.md",
    ]) {
      expect({ command, targets: targets(command) }).toEqual({ command, targets: ["notes.md"] });
    }
    expect(targets("sudo --some-flag cat notes.md")).toEqual([]);
  });

  test("env -S holds a command, in every spelling", () => {
    for (const command of [
      'printf x | env -S "tee notes.md"',
      "printf x | env -S'tee notes.md'",
      'printf x | env --split-string="tee notes.md"',
      'printf x | env --split-string "tee notes.md"',
      'printf x | env -iS "tee notes.md"',
      'printf x | env -S "-i FOO=1 tee -a notes.md"',
      'printf x | env -S "tee" notes.md',
    ]) {
      expect({ command, targets: targets(command) }).toEqual({ command, targets: ["notes.md"] });
    }
    expect(targets('env -S "echo tee" notes.md')).toEqual([]);
  });
});

describe("comments and backtick escapes", () => {
  test("a `)` inside a comment does not end a substitution", () => {
    expect(targets("printf x | tee $(printf README.md # )\n) notes.md")).toEqual(["notes.md"]);
    expect(targets("echo $(printf x # comment )\n > notes.md)")).toEqual(["notes.md"]);
  });

  test("a comment hides what follows it on its line, and only there", () => {
    expect(targets("printf x # > notes.md")).toEqual([]);
    expect(targets("printf x #> notes.md")).toEqual([]);
    expect(targets("printf x # comment\nprintf x > notes.md")).toEqual(["notes.md"]);
    expect(targets("printf a#b > notes.md")).toEqual(["notes.md"]);
    expect(targets("printf '#' > notes.md")).toEqual(["notes.md"]);
  });

  test("comment words are read; # inside a word or quotes starts no comment", () => {
    expect(comments("true;# .env\ncat x")).toEqual(["#", ".env"]);
    expect(comments("git status #server.key")).toEqual(["#server.key"]);
    expect(comments("echo $(git status # server.key\n)")).toEqual(["#", "server.key"]);
    expect(words("cat x#y .env")).toEqual(["cat", "x#y", ".env"]);
    expect(words('echo "#" .env')).toEqual(["echo", "#", ".env"]);
  });

  test("a heredoc marker inside a comment opens no heredoc", () => {
    expect(targets("true # <<EOF\nprintf x > notes.md\nEOF")).toEqual(["notes.md"]);
  });

  test("escaped backticks inside backticks lose one escape layer", () => {
    expect(targets('printf "%s" "`printf %s \\`printf x > nested.md\\``"')).toEqual(["nested.md"]);
    expect(targets("echo `echo \\`tee nested.md\\``")).toEqual(["nested.md"]);
    expect(targets("echo `echo \\$(tee nested.md)`")).toEqual(["nested.md"]);
  });

  test("a substitution's command is read inside double quotes and backticks, at any depth", () => {
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
      expect({ command, read: words(command).includes("cert.key") }).toEqual({
        command,
        read: true,
      });
    }
    expect(words("git commit -m 'see $(cat cert.key)'")).not.toContain("cert.key");
  });
});

describe("heredoc bodies", () => {
  test("drop the body and terminator, keeping the marker line", () => {
    expect(stripped("cat <<'EOF' > note.md\nsee > x.md\nEOF\nls")).toBe(
      "cat <<'EOF' > note.md\nls",
    );
    expect(stripped("cat <<-END\n\tbody\n\tEND\necho done")).toBe("cat <<-END\necho done");
    expect(stripped('cat <<A <<"B"\na\nA\nb\nB\nls')).toBe('cat <<A <<"B"\nls');
    expect(stripped("cat <<EOF\nbody > x.md")).toBe("cat <<EOF");
  });

  test("are not read; the redirects around them are", () => {
    const command = [
      "cat >> src/app.ts <<'EOF'",
      "const files = roots.flatMap((root) =>",
      '  ["CLAUDE.md", "AGENTS.md"].map((name) => path.join(root, name)),',
      ");",
      "echo notes > scratch/plan.md",
      "EOF",
    ].join("\n");
    expect(targets(command)).toEqual(["src/app.ts"]);
    expect(targets("cat <<'EOF' > notes/x.md\nbody\nEOF")).toEqual(["notes/x.md"]);
    expect(targets("cat > notes/x.md <<EOF\nbody\nEOF")).toEqual(["notes/x.md"]);
    expect(targets("cat <<EOF | sort\nbody\nEOF\necho x > notes/x.md")).toEqual(["notes/x.md"]);
    expect(targets("cat > src/a.ts <<'EOF'\necho x | tee notes.md\n> \"a b.md\"\nEOF")).toEqual([
      "src/a.ts",
    ]);
    expect(words("cat <<'EOF' > note.md\nsee .env\nEOF\nls")).toEqual(["cat", "note.md", "ls"]);
  });

  test("a line-end redirect or tee is not paired with a later line", () => {
    expect(targets("node -e 'a =>\nnotes.md'")).toEqual([]);
    expect(targets("echo hi | tee\nnotes.md")).toEqual([]);
  });

  test("a marker inside quotes or a here-string opens none", () => {
    const command = "git commit -m 'see <<EOF'\ncat <<< word\necho x > a.md";
    expect(stripped(command)).toBe(command);
    const ansi = "echo $'x\\' <<EOF'\ncat .env\nEOF";
    expect(stripped(ansi)).toBe(ansi);
    expect(stripped("echo $'x\\'' <<EOF\nbody\nEOF\nls")).toBe("echo $'x\\'' <<EOF\nls");
    expect(heredocs("git commit -m 'see <<EOF'\nls")).toEqual([[], []]);
  });

  test("the delimiter is the whole word after quote removal, as Bash takes it", () => {
    expect(stripped('cat <<E"OF"\nbody\nEOF\ncat cert.key')).toBe('cat <<E"OF"\ncat cert.key');
    expect(stripped("cat <<EOF+\nbody\nEOF+\ncat cert.key")).toBe("cat <<EOF+\ncat cert.key");
    expect(stripped("cat <<'E'OF\\!\nbody\nEOF!\nls")).toBe("cat <<'E'OF\\!\nls");
    expect(stripped("cat <<EOF;echo x\nbody\nEOF\nls")).toBe("cat <<EOF;echo x\nls");
    expect(targets('cat <<E"OF"\nbody\nEOF\nprintf x > notes.md')).toEqual(["notes.md"]);
  });

  test("a settled marker word is no word; one the reader cannot settle is read as words", () => {
    expect(words("cat <<-  'EOF' > x")).toEqual(["cat", "x"]);
    expect(words('cat <<E"OF"')).toEqual(["cat"]);
    expect(words("cat <<EOF+|x")).toEqual(["cat", "x"]);
    expect(words("cat <<\\EOF")).toEqual(["cat"]);
    expect(words('cat <<"$X"')).toEqual(["cat", "$X"]);
    expect(words("cat <<'EOF")).toEqual(["cat", "EOF"]);
  });

  test("a delimiter the reader cannot settle strips nothing", () => {
    for (const command of [
      "cat <<$(echo EOF)\nbody\nEOF\ncat cert.key",
      "cat <<$EOF\nbody\n$EOF\ncat cert.key",
      "cat <<`echo EOF`\nbody\nEOF\ncat cert.key",
      "cat <<\ncat cert.key",
      "cat <<'EOF\nbody\nEOF\ncat cert.key",
    ]) {
      expect(stripped(command)).toBe(command);
    }
  });

  test("a marker inside a quote that spans lines opens no heredoc", () => {
    const command = "printf '%s' '\n<<EOF\n'\ncat cert.key";
    expect(stripped(command)).toBe(command);
    const double = 'printf "%s" "\n<<EOF\n"\ncat cert.key';
    expect(stripped(double)).toBe(double);
    expect(targets("printf '%s' '\n<<EOF\n'\nprintf x > notes.md")).toEqual(["notes.md"]);
  });

  test("a marker that reads unquoted only in the whole command strips nothing", () => {
    // Bash opens this heredoc, but the line on its own starts inside a quote.
    const command = "echo 'a\nb' <<EOF\nbody\nEOF\ncat cert.key";
    expect(stripped(command)).toBe(command);
  });

  test("a quote nested in a parameter expansion stays open across lines", () => {
    for (const command of [
      'echo "${x:-"\n<<EOF\n"}"\ncat cert.key',
      "echo ${x:-<<EOF}\ncat cert.key",
      "echo ${x:-'\n<<EOF\n'}\ncat cert.key",
    ]) {
      expect(stripped(command)).toBe(command);
    }
    expect(stripped('echo "${x:-a}" <<EOF\nbody\nEOF\nls')).toBe('echo "${x:-a}" <<EOF\nls');
  });

  test("a shift in arithmetic opens no heredoc", () => {
    for (const command of [
      "echo $((1<<2))\ncat cert.key",
      "((x <<= 1))\ncat cert.key",
      "echo $[1<<2]\ncat cert.key",
    ]) {
      expect(stripped(command)).toBe(command);
    }
  });

  test("a heredoc inside a quoted command substitution is a heredoc", () => {
    expect(stripped(`git commit -m "$(cat <<'EOF'\nfix: x\n\nsee .env\nEOF\n)"\nls`)).toBe(
      `git commit -m "$(cat <<'EOF'\n)"\nls`,
    );
  });

  test("the body starts after the line where a quote opened on the marker line closes", () => {
    expect(stripped("cat <<EOF; echo 'a\nb'\nbody\nEOF\nls")).toBe("cat <<EOF; echo 'a\nb'\nls");
  });

  test("a line continuation moves the body below the next line", () => {
    expect(stripped("cat <<EOF \\\n> out.txt\nbody\nEOF\nls")).toBe("cat <<EOF \\\n> out.txt\nls");
  });

  test("each body goes to the command whose marker opened it; an unterminated one runs to the end", () => {
    expect(heredocs('cat <<A <<"B"\na1\na2\nA\nb\nB\nls')).toEqual([["a1\na2", "b"], []]);
    expect(heredocs("cat <<EOF\nbody")).toEqual([["body"]]);
    expect(heredocs("ls\ncat <<A\na\nA\ncat <<B\nb\nB")).toEqual([[], ["a"], ["b"]]);
  });

  test("a substitution whose bodies the whole command could not place reads them on its own", () => {
    // A quote spanning lines stops the reading of the whole command.
    expect(targets("echo 'a\nb' $(cat <<EOF\n> notes.md\nEOF\n)")).toEqual([]);
    // The marker is only one once the backticks are decoded.
    expect(targets('echo `echo "\\$(cat <<EOF\n>body.md\nEOF)"`')).toEqual([]);
  });

  test("a substitution keeps the bodies the whole command placed, and reads what follows them", () => {
    expect(targets("x=$(cat <<EOF\nbody\nEOF\necho hi > notes.md\n)")).toEqual(["notes.md"]);
  });
});
