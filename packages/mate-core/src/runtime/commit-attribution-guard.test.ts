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

describe("the refusal", () => {
  test("says no commit was created and to rerun without the trailer", () => {
    const refusal = checkCommitAttribution(`git commit -m "x" -m "${CLAUDE}"`) ?? "";
    expect(refusal).toContain("No commit was created");
    expect(refusal).toContain("without the Co-Authored-By trailer");
    expect(refusal).toContain("not allowed");
  });
});
