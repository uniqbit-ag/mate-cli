import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";

import { confirmPrompt } from "../lib/components/confirm-prompt";

function createTtyInput(): NodeJS.ReadStream & PassThrough {
  const stdin = new PassThrough() as NodeJS.ReadStream & PassThrough;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  (stdin as NodeJS.ReadStream & { ref: () => typeof stdin }).ref = () => stdin;
  (stdin as NodeJS.ReadStream & { unref: () => typeof stdin }).unref = () => stdin;
  return stdin;
}

function createPipeInput(): NodeJS.ReadStream & PassThrough {
  const stdin = new PassThrough() as NodeJS.ReadStream & PassThrough;
  stdin.isTTY = false;
  (stdin as NodeJS.ReadStream & { ref: () => typeof stdin }).ref = () => stdin;
  (stdin as NodeJS.ReadStream & { unref: () => typeof stdin }).unref = () => stdin;
  return stdin;
}

function createTtyOutput(): NodeJS.WriteStream & PassThrough {
  const stream = new PassThrough() as NodeJS.WriteStream & PassThrough;
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  return stream;
}

async function runConfirm(keys: string[]): Promise<boolean> {
  const stdin = createTtyInput();
  const stdout = createTtyOutput();
  const stderr = createTtyOutput();
  const promise = confirmPrompt("Continue?", { stdin, stdout, stderr });

  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const key of keys) stdin.write(key);

  return promise;
}

describe("confirmPrompt", () => {
  test("returns true when y is pressed", async () => {
    await expect(runConfirm(["y"])).resolves.toBe(true);
  });

  test("returns true when Y is pressed", async () => {
    await expect(runConfirm(["Y"])).resolves.toBe(true);
  });

  test("returns false when n is pressed", async () => {
    await expect(runConfirm(["n"])).resolves.toBe(false);
  });

  test("returns false when q is pressed", async () => {
    await expect(runConfirm(["q"])).resolves.toBe(false);
  });

  test("returns false on enter when default No is selected", async () => {
    await expect(runConfirm(["\r"])).resolves.toBe(false);
  });

  test("returns true after navigating to Yes and pressing enter", async () => {
    await expect(runConfirm(["\x1b[C", "\r"])).resolves.toBe(true);
  });

  test("returns false after navigating back to No and pressing enter", async () => {
    await expect(runConfirm(["\x1b[C", "\x1b[D", "\r"])).resolves.toBe(false);
  });

  test("returns true for piped non-TTY stdin", async () => {
    const stdin = createPipeInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();
    const promise = confirmPrompt("Continue?", { stdin, stdout, stderr });

    stdin.end("y\n");

    await expect(promise).resolves.toBe(true);
  });

  test("returns false immediately in CI for ambient non-TTY stdin", async () => {
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      await expect(confirmPrompt("Continue?", { stdout, stderr })).resolves.toBe(false);
    } finally {
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
    }
  });
});
