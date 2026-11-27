import { describe, expect, test } from "bun:test";

import { isPushNotPermitted, isRejectedPush } from "./refs";

const refused = (stderr: string) => ({
  status: 1,
  stdout: "",
  stderr,
  transport: "other" as const,
});

describe("isPushNotPermitted", () => {
  test.each([
    "remote: error: GH006: Protected branch update failed for refs/heads/main.",
    "remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Changes must be made through a pull request.",
    "remote: GitLab: You are not allowed to push code to protected branches on this project.",
    "remote: Branch refs/heads/main can only be modified through pull requests.",
    "remote: TF402455: Pushes to this branch are not permitted; you must use a pull request to update this branch.",
    "remote: Permission to acme/companion.git denied to acme-bot.\nfatal: unable to access: The requested URL returned error: 403",
  ])("a refusal of this user's rights: %s", (stderr) => {
    expect(isPushNotPermitted(refused(stderr))).toBe(true);
  });

  test.each([
    "remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - GITHUB PUSH PROTECTION\nremote:   Push cannot contain secrets",
    " ! [remote rejected] HEAD -> main (pre-receive hook declined)",
    " ! [remote rejected] HEAD -> main (cannot lock ref 'refs/heads/main')",
    " ! [rejected]        HEAD -> main (fetch first)",
  ])("a refusal nobody can push past, or a moved branch: %s", (stderr) => {
    expect(isPushNotPermitted(refused(stderr))).toBe(false);
  });
});

describe("isRejectedPush", () => {
  test.each([
    " ! [rejected]        HEAD -> main (fetch first)",
    " ! [remote rejected] HEAD -> mate/inbox (reference already exists)",
    " ! [remote rejected] HEAD -> mate/inbox (cannot lock ref 'refs/heads/mate/inbox')",
  ])("a moved or concurrently created branch: %s", (stderr) => {
    expect(isRejectedPush(refused(stderr))).toBe(true);
  });

  test("a local tracking-ref lock failure after an accepted push is not one", () => {
    expect(
      isRejectedPush(
        refused(
          "To ../origin.git\n   1a2b3c4..5d6e7f8  HEAD -> mate/inbox\nerror: update_ref failed for ref 'refs/remotes/origin/mate/inbox': cannot lock ref 'refs/remotes/origin/mate/inbox'",
        ),
      ),
    ).toBe(false);
  });

  test("a hook refusal is not one", () => {
    expect(
      isRejectedPush(refused(" ! [remote rejected] HEAD -> main (pre-receive hook declined)")),
    ).toBe(false);
  });
});
