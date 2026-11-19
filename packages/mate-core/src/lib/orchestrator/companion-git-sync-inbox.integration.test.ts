import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../test/git-checkouts";
import { makeStagingFixture, type StagingFixture } from "../../../test/staging-fixture";
import { CompanionGitSync } from "./companion-git-sync";

const TIMEOUT = 60_000;
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe("companion sync and the inbox", () => {
  test(
    "a remote without an inbox synchronizes and fetches none",
    async () => {
      const fixture = await makeStagingFixture();
      fixtures.push(fixture);
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      git(theirs, "commit", "-q", "--allow-empty", "-m", "acme work");
      git(theirs, "push", "-q", "origin", "HEAD");

      const outcome = await new CompanionGitSync().sync(mine);

      expect(outcome.changed).toBe(true);
      expect(git(mine, "rev-parse", "HEAD")).toBe(git(theirs, "rev-parse", "HEAD"));
      expect(git(mine, "for-each-ref", "refs/remotes/origin/mate/").trim()).toBe("");
    },
    TIMEOUT,
  );

  test(
    "fetches an inbox pushed after the clone",
    async () => {
      const fixture = await makeStagingFixture();
      fixtures.push(fixture);
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      git(theirs, "push", "-q", "origin", "HEAD:refs/heads/mate/inbox");

      await new CompanionGitSync().sync(mine);

      expect(git(mine, "for-each-ref", "refs/remotes/origin/mate/").trim()).not.toBe("");
    },
    TIMEOUT,
  );

  test(
    "a checkout tracking another branch fetches the inbox too",
    async () => {
      const fixture = await makeStagingFixture();
      fixtures.push(fixture);
      const theirs = fixture.clone("acme-theirs");
      git(theirs, "push", "-q", "origin", "HEAD:refs/heads/acme-feature");
      const mine = fixture.clone("acme-mine");
      git(mine, "switch", "-q", "--track", "-c", "acme-feature", "origin/acme-feature");
      git(theirs, "push", "-q", "origin", "HEAD:refs/heads/mate/inbox");

      await new CompanionGitSync().sync(mine);

      expect(git(mine, "for-each-ref", "refs/remotes/origin/mate/").trim()).not.toBe("");
    },
    TIMEOUT,
  );
});
