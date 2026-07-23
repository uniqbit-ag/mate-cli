import { PassThrough } from "node:stream";
import { describe, expect, mock, test } from "bun:test";
import { runLaunchWizard } from "./launch-selector";

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

async function runWizard(
  keys: string[],
  options: {
    allowedTargets?: Set<string>;
    resolvePreview?: ReturnType<typeof mock>;
  } = {},
): Promise<{
  result: Awaited<ReturnType<typeof runLaunchWizard>>;
  output: string;
  resolvePreview: ReturnType<typeof mock>;
}> {
  const stdin = createTtyInput();
  const stdout = createTtyOutput();
  const stderr = createTtyOutput();
  const resolvePreview =
    options.resolvePreview ??
    mock(async () => ({
      repositoryId: "repo",
      repositoryPath: "/tmp/repo",
      companionPath: "/tmp/companion",
    }));

  const promise = runLaunchWizard({
    stdin,
    stdout,
    stderr,
    allowedTargets: options.allowedTargets,
    resolvePreview,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const key of keys) {
    stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const result = await promise;
  return {
    result,
    output: stdout.read()?.toString() ?? "",
    resolvePreview,
  };
}

describe("runLaunchWizard", () => {
  test("confirms default target through review", async () => {
    const { result, output, resolvePreview } = await runWizard(["\r", "\r"]);

    expect(result).toEqual({
      target: "claude",
      preview: {
        repositoryId: "repo",
        repositoryPath: "/tmp/repo",
        companionPath: "/tmp/companion",
      },
    });
    expect(resolvePreview).toHaveBeenCalledWith("claude");
    expect(output).toContain("/tmp/repo");
    expect(output).toContain("/tmp/companion");
  });

  test("navigates to a different target before review", async () => {
    const { result, output } = await runWizard(["[B", "\r", "\r"]);

    expect(result?.target).toBe("codex");
    expect(output).toContain("Companion:");
  });

  test("skips disallowed targets while navigating", async () => {
    const { result } = await runWizard(["[B", "\r", "\r"], {
      allowedTargets: new Set(["claude", "opencode"]),
    });

    expect(result?.target).toBe("opencode");
  });

  test("cancels cleanly from review", async () => {
    const { result } = await runWizard(["\r", "q"]);
    expect(result).toBeNull();
  });
});
