import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  UpdateStateStore,
  fetchLatestVersion,
  getCurrentVersion,
  isCanaryVersion,
  isNewer,
  scheduleBackgroundCheck,
  showUpdateBannerIfAvailable,
  updateCheckerDeps,
} from "./update-checker";
import { publicNpmDeps, PUBLIC_NPM_REGISTRY } from "./public-npm";

beforeEach(() => {
  publicNpmDeps.execFile = mock(async () => ({ stdout: "9.9.9\n", stderr: "" }));
  updateCheckerDeps.now = () => Date.now();
  updateCheckerDeps.toIsoString = () => new Date().toISOString();
});

afterEach(() => {
  mock.restore();
});

function createStore(state: { lastChecked: string; latestVersion: string | null }) {
  return {
    load: mock(async () => state),
    save: mock(async () => {}),
  };
}

async function flushBackgroundWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("isNewer", () => {
  test("major version upgrade", () => {
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  });

  test("minor version upgrade", () => {
    expect(isNewer("1.2.0", "1.1.9")).toBe(true);
  });

  test("patch version upgrade", () => {
    expect(isNewer("1.0.2", "1.0.1")).toBe(true);
  });

  test("same version is not newer", () => {
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  });

  test("older major is not newer", () => {
    expect(isNewer("0.9.9", "1.0.0")).toBe(false);
  });

  test("older minor is not newer", () => {
    expect(isNewer("1.0.9", "1.1.0")).toBe(false);
  });

  test("older patch is not newer", () => {
    expect(isNewer("1.0.0", "1.0.1")).toBe(false);
  });
});

describe("isCanaryVersion", () => {
  test("detects a canary prerelease version", () => {
    expect(isCanaryVersion("0.11.0-canary.8")).toBe(true);
  });

  test("treats a stable version as non-canary", () => {
    expect(isCanaryVersion("0.11.0")).toBe(false);
  });
});

describe("update helpers", () => {
  test("returns the packaged current version", () => {
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("UpdateStateStore resolves the default missing state", async () => {
    const store = new UpdateStateStore();

    await expect((store as any).onMissing()).resolves.toEqual({
      lastChecked: "",
      latestVersion: null,
    });
  });

  test("shows an update banner when a newer version is available", async () => {
    const store = createStore({ lastChecked: "", latestVersion: "999.0.0" });
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      await showUpdateBannerIfAvailable(store as never);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrChunks.join("")).toContain("update available");
    expect(stderrChunks.join("")).toContain("Run `mate update`");
  });

  test("does not show a banner when no newer version is available", async () => {
    const store = createStore({ lastChecked: "", latestVersion: getCurrentVersion() });
    const stderrWrite = mock(() => true);
    const originalWrite = process.stderr.write;
    process.stderr.write = stderrWrite as typeof process.stderr.write;

    try {
      await showUpdateBannerIfAvailable(store as never);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrWrite).not.toHaveBeenCalled();
  });

  test("swallows banner load failures", async () => {
    const stderrWrite = mock(() => true);
    const originalWrite = process.stderr.write;
    process.stderr.write = stderrWrite as typeof process.stderr.write;

    try {
      await expect(
        showUpdateBannerIfAvailable({
          load: async () => {
            throw new Error("boom");
          },
        } as never),
      ).resolves.toBeUndefined();
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrWrite).not.toHaveBeenCalled();
  });

  test("fetches and trims the latest npm version", async () => {
    publicNpmDeps.execFile = mock(async (command, args, options) => {
      expect(command).toBe("npm");
      expect(args).toEqual(["view", "@uniqbit/mate", "version"]);
      expect(options).toMatchObject({ timeout: 10_000 });

      const userConfigPath = options?.env?.NPM_CONFIG_USERCONFIG;
      expect(userConfigPath).toBeTruthy();
      await expect(fs.readFile(userConfigPath!, "utf8")).resolves.toBe(
        `registry=${PUBLIC_NPM_REGISTRY}\n@uniqbit:registry=${PUBLIC_NPM_REGISTRY}\n`,
      );

      return { stdout: "1.2.3\n", stderr: "" };
    });

    await expect(fetchLatestVersion()).resolves.toBe("1.2.3");
  });

  test("schedules and saves a background update check when the cache is stale", async () => {
    const staleDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const store = createStore({ lastChecked: staleDate, latestVersion: null });
    updateCheckerDeps.toIsoString = () => "2026-01-01T00:00:00.000Z";

    scheduleBackgroundCheck(store as never);
    await flushBackgroundWork();

    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save.mock.calls[0]?.[0]).toEqual({
      lastChecked: "2026-01-01T00:00:00.000Z",
      latestVersion: "9.9.9",
    });
  });

  test("skips the background update check when it ran recently", async () => {
    const store = createStore({ lastChecked: new Date().toISOString(), latestVersion: null });

    scheduleBackgroundCheck(store as never);
    await flushBackgroundWork();

    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.save).not.toHaveBeenCalled();
  });

  test("swallows background check failures", async () => {
    publicNpmDeps.execFile = mock(async () => {
      throw new Error("network");
    });
    const store = createStore({ lastChecked: "", latestVersion: null });

    scheduleBackgroundCheck(store as never);
    await flushBackgroundWork();

    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.save).not.toHaveBeenCalled();
  });
});
