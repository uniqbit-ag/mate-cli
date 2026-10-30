import { describe, expect, test } from "bun:test";

import { factoryGitEnv } from "./factory-runner";

describe("the factory's Git author", () => {
  test("is Mate factory by default, as author and committer", () => {
    expect(factoryGitEnv({})).toEqual({
      GIT_AUTHOR_NAME: "Mate factory",
      GIT_AUTHOR_EMAIL: "factory@mate.invalid",
      GIT_COMMITTER_NAME: "Mate factory",
      GIT_COMMITTER_EMAIL: "factory@mate.invalid",
    });
  });

  test("is the operator's bot account when one is named", () => {
    expect(
      factoryGitEnv({
        MATE_FACTORY_GIT_NAME: "acme-mate-bot",
        MATE_FACTORY_GIT_EMAIL: "mate-bot@acme.test",
      }),
    ).toMatchObject({
      GIT_AUTHOR_NAME: "acme-mate-bot",
      GIT_COMMITTER_EMAIL: "mate-bot@acme.test",
    });
  });

  test("ignores blank values", () => {
    expect(factoryGitEnv({ MATE_FACTORY_GIT_NAME: " ", MATE_FACTORY_GIT_EMAIL: "" })).toMatchObject(
      { GIT_AUTHOR_NAME: "Mate factory", GIT_AUTHOR_EMAIL: "factory@mate.invalid" },
    );
  });
});
