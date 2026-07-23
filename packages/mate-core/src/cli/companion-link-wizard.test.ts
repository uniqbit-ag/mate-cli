import { describe, expect, test } from "bun:test";

import { selectCompanionLinkInputs } from "./companion-link-wizard";
import { createTtyInput, createTtyOutput } from "../../test/helpers";

describe("selectCompanionLinkInputs", () => {
  test("selects local and captures a pasted path", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();
    const localPath = "/tmp/companion repo";

    const selectionPromise = selectCompanionLinkInputs({
      profiles: ["default"],
      existingCompanions: ["/tmp/managed-companion"],
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write("\u001b[B");
    stdin.write("\u001b[B");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write(localPath);
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      source: "local",
      localPath,
      gitUrl: undefined,
      companionPaths: undefined,
      profile: "default",
    });
  });
});
