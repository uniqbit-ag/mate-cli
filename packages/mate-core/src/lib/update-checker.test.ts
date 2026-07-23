import fsSync from "node:fs";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  UpdateStateStore,
  enforceUpdateIfRequired,
  fetchLatestVersion,
  getCurrentVersion,
  isCanaryVersion,
  isNewer,
  scheduleBackgroundCheck,
  showUpdateBannerIfAvailable,
  updateCheckerDeps,
} from "./update-checker";
import { installPublicPackageSync, publicNpmDeps, PUBLIC_NPM_REGISTRY } from "./public-npm";
import { getActiveDistribution, setActiveDistribution } from "../distribution";

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

  test("uses the distribution update package and registry", async () => {
    const previous = getActiveDistribution();
    setActiveDistribution({
      ...previous,
      config: {
        ...previous.config,
        update: {
          packageName: "@acme/mate",
          registry: "https://npm.acme.test/",
        },
      },
    });

    publicNpmDeps.execFile = mock(async (command, args, options) => {
      expect(command).toBe("npm");
      expect(args).toEqual(["view", "@acme/mate", "version"]);
      const userConfigPath = options?.env?.NPM_CONFIG_USERCONFIG;
      expect(userConfigPath).toBeTruthy();
      await expect(fs.readFile(userConfigPath!, "utf8")).resolves.toBe(
        "registry=https://npm.acme.test/\n@acme:registry=https://npm.acme.test/\n",
      );
      return { stdout: "2.3.4\n", stderr: "" };
    });

    try {
      await expect(fetchLatestVersion()).resolves.toBe("2.3.4");
    } finally {
      setActiveDistribution(previous);
    }
  });

  test("uses the configured registry for global installation", () => {
    const originalSpawnSync = publicNpmDeps.spawnSync;
    const spawnSync = mock((command, args, options) => {
      expect(command).toBe("npm");
      expect(args).toEqual(["install", "-g", "@acme/mate@2.3.4"]);
      const userConfigPath = options?.env?.NPM_CONFIG_USERCONFIG;
      expect(userConfigPath).toBeTruthy();
      expect(fsSync.readFileSync(userConfigPath!, "utf8")).toBe(
        "registry=https://npm.acme.test/\n@acme:registry=https://npm.acme.test/\n",
      );
      return { status: 0, error: undefined } as never;
    });
    publicNpmDeps.spawnSync = spawnSync;

    try {
      expect(installPublicPackageSync("@acme/mate@2.3.4", "https://npm.acme.test/").status).toBe(0);
    } finally {
      publicNpmDeps.spawnSync = originalSpawnSync;
    }
  });

  test("schedules a background update check once the cache is older than six hours", async () => {
    const staleDate = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const store = createStore({ lastChecked: staleDate, latestVersion: null });
    updateCheckerDeps.toIsoString = () => "2026-01-01T00:00:00.000Z";

    scheduleBackgroundCheck(store as never);
    await flushBackgroundWork();

    expect(store.save).toHaveBeenCalledTimes(1);
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

  test("enforceUpdateIfRequired blocks when the distribution enforces updates and a newer version is cached", async () => {
    const previous = getActiveDistribution();
    setActiveDistribution({
      ...previous,
      config: { ...previous.config, update: { enforce: true } },
    });
    const store = createStore({ lastChecked: "", latestVersion: "999.0.0" });
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      await expect(enforceUpdateIfRequired(store as never)).resolves.toBe(true);
    } finally {
      process.stderr.write = originalWrite;
      setActiveDistribution(previous);
    }

    expect(stderrChunks.join("")).toContain("update required");
    expect(stderrChunks.join("")).toContain("Run `mate update`");
  });

  test("enforceUpdateIfRequired does not block when the distribution does not enforce updates", async () => {
    const store = createStore({ lastChecked: "", latestVersion: "999.0.0" });

    await expect(enforceUpdateIfRequired(store as never)).resolves.toBe(false);
    expect(store.load).not.toHaveBeenCalled();
  });

  test("enforceUpdateIfRequired does not block when already up to date", async () => {
    const previous = getActiveDistribution();
    setActiveDistribution({
      ...previous,
      config: { ...previous.config, update: { enforce: true } },
    });
    const store = createStore({ lastChecked: "", latestVersion: getCurrentVersion() });

    try {
      await expect(enforceUpdateIfRequired(store as never)).resolves.toBe(false);
    } finally {
      setActiveDistribution(previous);
    }
  });

  test("enforceUpdateIfRequired never blocks on state-load failures", async () => {
    const previous = getActiveDistribution();
    setActiveDistribution({
      ...previous,
      config: { ...previous.config, update: { enforce: true } },
    });

    try {
      await expect(
        enforceUpdateIfRequired({
          load: async () => {
            throw new Error("boom");
          },
        } as never),
      ).resolves.toBe(false);
    } finally {
      setActiveDistribution(previous);
    }
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
