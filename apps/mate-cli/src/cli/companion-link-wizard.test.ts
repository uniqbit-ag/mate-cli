import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import { selectCompanionLinkInputs } from "./companion-link-wizard";

function createTtyInput(): NodeJS.ReadStream & PassThrough {
  const stdin = new PassThrough() as NodeJS.ReadStream & PassThrough;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  (stdin as unknown as { ref: () => typeof stdin }).ref = () => stdin;
  (stdin as unknown as { unref: () => typeof stdin }).unref = () => stdin;
  return stdin;
}

function createTtyOutput(): NodeJS.WriteStream & PassThrough {
  const stream = new PassThrough() as NodeJS.WriteStream & PassThrough;
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  return stream;
}

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
