import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { selectCompanion } from "./companion-selector";
import { createTtyInput, createTtyOutput } from "../../test/helpers";

const matches = [
  { companionPath: "/tmp/companion-a", repositoryId: "from-a" },
  { companionPath: "/tmp/companion-b", repositoryId: "from-b" },
];

async function runSelector(
  keys: string[],
): Promise<{ result: Awaited<ReturnType<typeof selectCompanion>>; output: string }> {
  const stdin = createTtyInput();
  const stdout = createTtyOutput();
  const stderr = createTtyOutput();

  const promise = selectCompanion(matches, { stdin, stdout, stderr });

  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const key of keys) {
    stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const result = await promise;
  return { result, output: stdout.read()?.toString() ?? "" };
}

describe("selectCompanion", () => {
  test("selects the first companion by default on enter", async () => {
    const { result, output } = await runSelector(["\r"]);

    expect(result).toEqual(matches[0]!);
    expect(output).toContain("/tmp/companion-a");
    expect(output).toContain("/tmp/companion-b");
  });

  test("navigates to the second companion before selecting", async () => {
    const { result } = await runSelector(["[B", "\r"]);

    expect(result).toEqual(matches[1]!);
  });

  test("wraps navigation from the last item back to the first", async () => {
    const { result } = await runSelector(["[B", "[B", "\r"]);

    expect(result).toEqual(matches[0]!);
  });

  test("cancels cleanly on q", async () => {
    const { result } = await runSelector(["q"]);

    expect(result).toBeNull();
  });

  test("cancels cleanly on escape", async () => {
    const { result } = await runSelector(["\x1b"]);

    expect(result).toBeNull();
  });

  test("throws when not run in a TTY", async () => {
    const stdin = new PassThrough() as NodeJS.ReadStream & PassThrough;
    stdin.isTTY = false;
    const stdout = createTtyOutput();

    await expect(selectCompanion(matches, { stdin, stdout })).rejects.toThrow(
      "Companion selector requires a TTY.",
    );
  });
});
