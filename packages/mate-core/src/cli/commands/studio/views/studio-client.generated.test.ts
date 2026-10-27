import { describe, expect, test } from "bun:test";

import { checkStudioClient } from "../../../../../../../scripts/studio-client/build";

describe("Studio's built client", () => {
  test("the committed module matches a fresh build of the typed modules", async () => {
    expect(await checkStudioClient()).toEqual([]);
  }, 30_000);
});
