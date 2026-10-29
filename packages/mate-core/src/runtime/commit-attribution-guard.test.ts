import { describe, expect, test } from "bun:test";

import { checkCommitAttribution } from "./commit-attribution-guard";

const CLAUDE = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

describe("checkCommitAttribution refuses a model co-author trailer", () => {
  test.each([
    ["a second -m argument", `git commit -m "fix: x" -m "${CLAUDE}"`],
    ["an attached -m value", `git commit -m"fix: x" -m"${CLAUDE}"`],
    ["a --message= value", `git commit --message="${CLAUDE}"`],
    ["a separate --message value", `git commit --message '${CLAUDE}'`],
    ["a -am cluster", `git commit -am "fix: x\n\n${CLAUDE}"`],
    ["a lowercase trailer", `git commit -m "co-authored-by: claude <noreply@anthropic.com>"`],
    ["a chained commit", `git add -A && git commit -m "${CLAUDE}"`],
    ["a commit after ;", `git status; git commit -m "${CLAUDE}"`],
    ["git -C dir commit", `git -C packages/core commit -m "${CLAUDE}"`],
    ["an env prefix", `env GIT_AUTHOR_NAME=x FOO=1 git commit -m "${CLAUDE}"`],
    ["another model vendor", `git commit -m "Co-authored-by: GPT-5 Codex <codex@openai.com>"`],
    ["an anthropic address only", `git commit -m "Co-Authored-By: Bot <bot@anthropic.com>"`],
    ["a model inside a word", `git commit -m "Co-Authored-By: ChatGPT <x@acme.example>"`],
    ["a --trailer value", `git commit --trailer "${CLAUDE}" -m fix`],
    ["a --trailer= key=value", "git commit --trailer=Co-authored-by=Claude -m fix"],
    ["a printf-escaped newline", `git commit -m "$(printf 'fix\\n\\nCo-Authored-By: Claude')"`],
    ["an ANSI-C quoted newline", "git commit -m $'fix\\n\\nCo-Authored-By: Claude'"],
    ["a sudo prefix", `sudo -E git commit -m "${CLAUDE}"`],
    ["an absolute git path", `/usr/bin/git commit -m "${CLAUDE}"`],
    ["a subshell", `(git commit -m "${CLAUDE}")`],
  ])("in %s", (_label, command) => {
    expect(checkCommitAttribution(command)).not.toBeNull();
  });

  test("in a heredoc message", () => {
    const command = [
      `git commit -m "$(cat <<'EOF'`,
      "feat: add guard",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "EOF",
      `)"`,
    ].join("\n");
    expect(checkCommitAttribution(command)).not.toBeNull();
  });

  test("in a heredoc piped to git commit -F -", () => {
    const command = ["git commit -F - <<'EOF'", "fix", "", CLAUDE, "EOF"].join("\n");
    expect(checkCommitAttribution(command)).not.toBeNull();
  });
});

describe("checkCommitAttribution allows", () => {
  test.each([
    [
      "a human co-author",
      `git commit -m "feat: y" -m "Co-Authored-By: Jane Doe <jane@acme.example>"`,
    ],
    ["a non-commit command naming the trailer", `grep -rn "Co-Authored-By: Claude" docs`],
    ["a message file", "git commit -F msg.txt"],
    ["a template", "git commit -t template.txt"],
    ["an editor commit", "git commit"],
    ["a model named outside a trailer", `git commit -m "docs: explain Claude settings"`],
    ["git log with a trailer grep", `git log --grep "Co-Authored-By: Claude"`],
    ["a -C value naming commit", `git -C commit log -m "${CLAUDE}"`],
    ["a quoted separator in a message", `echo "a && git commit -m ${CLAUDE}"`],
  ])("%s", (_label, command) => {
    expect(checkCommitAttribution(command)).toBeNull();
  });

  test("a heredoc another command writes before the commit", () => {
    const command = [
      "cat <<'EOF' > msg.txt",
      "fix",
      "",
      CLAUDE,
      "EOF",
      "git commit -F msg.txt",
    ].join("\n");
    expect(checkCommitAttribution(command)).toBeNull();
  });
});

describe("the shared shell reading finds commits the old tokenizer missed", () => {
  test.each([
    ["sudo -u", `sudo -u bob git commit -m "${CLAUDE}"`],
    ["nice -n", `nice -n 5 git commit -m "${CLAUDE}"`],
    ["env -u", `env -u HOME git commit -m "${CLAUDE}"`],
    ["exec -a", `exec -a name git commit -m "${CLAUDE}"`],
    ["time -f", `time -f %e git commit -m "${CLAUDE}"`],
    ["stdbuf", `stdbuf -o0 git commit -m "${CLAUDE}"`],
    ["xargs", `xargs -I {} git commit -m "${CLAUDE}"`],
    ["env -S", `env -S "git commit -m '${CLAUDE}'"`],
    ["if …; then", `if true; then git commit -m "${CLAUDE}"; fi`],
    ["a quoted substitution", `echo "$(git commit -m '${CLAUDE}')"`],
    ["backticks", `echo \`git commit -m "${CLAUDE}"\``],
    ["a quote in a comment on the line before", `# don't\ngit commit -m "${CLAUDE}"`],
    ["an ANSI-C hex escape", "git commit -m $'fix\\x0aCo-Authored-By: Claude'"],
    ["a backslash-newline inside double quotes", 'git commit -m "Co-Authored-By: Cl\\\naude"'],
    ["NAME+=value", `X+=1 git commit -m "${CLAUDE}"`],
    ["git --git-dir", `git --git-dir .git commit -m "${CLAUDE}"`],
    ["a substitution that expands to nothing", `$(true) git commit -m "${CLAUDE}"`],
    ["a substitution joined to the name", `$(true)git commit -m "${CLAUDE}"`],
    ["a substitution that expands to a path", `$(echo /usr/bin/)git commit -m "${CLAUDE}"`],
    ["two substitutions", `$(true) $(true) git commit -m "${CLAUDE}"`],
    ["a substitution and a wrapper", `$(true) sudo -u bob git commit -m "${CLAUDE}"`],
    ["a substitution among git's options", `git $(true) commit -m "${CLAUDE}"`],
  ])("behind %s", (_label, command) => {
    expect(checkCommitAttribution(command)).not.toBeNull();
  });

  test("in a heredoc piped into the commit", () => {
    const command = ["cat <<'EOF' | git commit -F -", "fix", "", CLAUDE, "EOF"].join("\n");
    expect(checkCommitAttribution(command)).not.toBeNull();
  });

  test.each([
    ["piped into a group", "cat <<'EOF' | { true; git commit -F -; }"],
    ["piped into a subshell", "cat <<'EOF' | (true; git commit -F -)"],
    ["piped into a loop", "cat <<'EOF' | while read -r line; do git commit -F -; done"],
    ["piped out of a group", "{ echo fix; cat <<'EOF'; } | git commit -F -"],
    ["piped out of a subshell", "(cat <<'EOF'; echo) | git commit -F -"],
    ["piped out of if", "if true; then cat <<'EOF'; fi | git commit -F -"],
    ["piped out of for", "for f in a; do cat <<'EOF'; done | git commit -F -"],
    ["piped through a group", "cat <<'EOF' | { cat; } | git commit -F -"],
    ["piped with |&", "cat <<'EOF' |& git commit -F -"],
    ["on a loop's closer", "while read -r line; do git commit -F -; done <<'EOF'"],
    ["on a subshell's closer", "(true; git commit -F -) <<'EOF'"],
  ])("in a heredoc %s", (_label, firstLine) => {
    const command = [firstLine, "fix", "", CLAUDE, "EOF"].join("\n");
    expect(checkCommitAttribution(command)).not.toBeNull();
  });

  test.each([
    ["-F <(…)", "git commit -F <(cat <<'EOF'", ")"],
    ["--file=<(…)", "git commit --file=<(cat <<'EOF'", ")"],
    ["< <(…)", "git commit -F - < <(cat <<'EOF'", ")"],
    ['<<<"$(…)"', "git commit -F - <<<\"$(cat <<'EOF'", ')"'],
  ])("in a heredoc a substitution in %s feeds the commit", (_label, firstLine, closing) => {
    const command = [firstLine, "fix", "", CLAUDE, "EOF", closing].join("\n");
    expect(checkCommitAttribution(command)).not.toBeNull();
  });

  test("in a here-string", () => {
    expect(checkCommitAttribution(`git commit -F - <<< "fix\n\n${CLAUDE}"`)).not.toBeNull();
  });

  test.each([
    ["a case arm in a subshell", `(case x in x) git commit -m "${CLAUDE}";; esac)`],
    ["an array assignment", `a=() git commit -m "${CLAUDE}"`],
  ])("in %s", (_label, command) => {
    expect(checkCommitAttribution(command)).not.toBeNull();
  });

  test.each([
    ["time { … } <<EOF", "time { git commit -F -; } <<'EOF'"],
    ["a group with a quoted } inside", "{ '}'; git commit -F -; } <<'EOF'"],
    [
      "a case arm whose pattern is done",
      "for i in 1; do case $i in done) cat <<'EOF';; esac; done | git commit -F -",
    ],
  ])("in a heredoc reaching %s", (_label, firstLine) => {
    const command = [firstLine, "fix", "", CLAUDE, "EOF"].join("\n");
    expect(checkCommitAttribution(command)).not.toBeNull();
  });

  test("not in a heredoc written to a file inside a group", () => {
    const command = [
      "{ cat <<'EOF' >msg.txt; git commit -F msg.txt; } | cat",
      "fix",
      "",
      CLAUDE,
      "EOF",
    ].join("\n");
    expect(checkCommitAttribution(command)).toBeNull();
  });

  test("not in a heredoc written to a file before the commit on the same line", () => {
    const command = ["cat <<'EOF' >msg.txt; git commit -F msg.txt", "fix", "", CLAUDE, "EOF"].join(
      "\n",
    );
    expect(checkCommitAttribution(command)).toBeNull();
  });

  test("not in a heredoc a shell function call pipes into the commit", () => {
    const command = ["f() { cat <<'EOF'; }; f | git commit -F -", "fix", "", CLAUDE, "EOF"].join(
      "\n",
    );
    expect(checkCommitAttribution(command)).toBeNull();
  });

  test("not in a commit named only inside a quoted argument", () => {
    expect(checkCommitAttribution(`echo "a && git commit -m '${CLAUDE}'"`)).toBeNull();
  });
});

describe("the refusal", () => {
  test("says no commit was created and to rerun without the trailer", () => {
    const refusal = checkCommitAttribution(`git commit -m "x" -m "${CLAUDE}"`) ?? "";
    expect(refusal).toContain("No commit was created");
    expect(refusal).toContain("without the Co-Authored-By trailer");
    expect(refusal).toContain("not allowed");
  });
});
