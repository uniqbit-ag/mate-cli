import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { emitWarning, installLiveProgress, releaseTerminal } from "./live-progress";

describe("live progress hook", () => {
  const restores: (() => void)[] = [];
  afterEach(() => {
    while (restores.length) restores.pop()?.();
  });

  test("emitWarning writes to stderr when no progress is live", () => {
    const write = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      emitWarning("acme capability disabled: missing tool");
      expect(write).toHaveBeenCalledWith("acme capability disabled: missing tool\n");
    } finally {
      write.mockRestore();
    }
  });

  test("releaseTerminal is a no-op when no progress is live", () => {
    expect(() => releaseTerminal()).not.toThrow();
  });

  test("an installed hook receives warnings and releases until restored", () => {
    const warnings: string[] = [];
    let releases = 0;
    const restore = installLiveProgress({
      warn: (message) => warnings.push(message),
      releaseTerminal: () => {
        releases += 1;
      },
    });
    restores.push(restore);

    emitWarning("acme warning");
    releaseTerminal();
    expect(warnings).toEqual(["acme warning"]);
    expect(releases).toBe(1);

    restore();
    const write = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      emitWarning("after stop");
      expect(write).toHaveBeenCalledWith("after stop\n");
      expect(warnings).toEqual(["acme warning"]);
    } finally {
      write.mockRestore();
    }
  });
});
