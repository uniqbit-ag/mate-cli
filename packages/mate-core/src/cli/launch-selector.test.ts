import { describe, expect, mock, test } from "bun:test";
import { runLaunchWizard } from "./launch-selector";
import { createTtyInput, createTtyOutput } from "../../test/helpers";

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

    expect(result?.target).toBe("opencode");
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
