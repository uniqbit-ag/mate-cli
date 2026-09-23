import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  UPDATE_POLICY_ENV,
  enforceUpdateIfRequired,
  getCurrentVersion,
  getUpdatePolicy,
  isPinnedDeployment,
  resetUpdatePolicyReport,
  scheduleBackgroundCheck,
  showUpdateBannerIfAvailable,
  updateCheckerDeps,
} from "./update-checker";
import { publicNpmDeps } from "./public-npm";
import { getActiveDistribution, setActiveDistribution } from "../distribution";

const YEAR_AGO = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

let originalPolicy: string | undefined;
let originalStderrWrite: typeof process.stderr.write;
let stderrChunks: string[];
let registryLookups: number;
/** Assigned, not spied, so `mock.restore()` would leave the fake registry in place for later files. */
const originalExecFile = publicNpmDeps.execFile;
const originalNow = updateCheckerDeps.now;
const originalToIsoString = updateCheckerDeps.toIsoString;

/** Absent, stale, and newer-version caches — the three states the policy must ignore. */
const CACHES = {
  absent: { lastChecked: "", latestVersion: null as string | null },
  stale: { lastChecked: YEAR_AGO, latestVersion: getCurrentVersion() },
  newer: { lastChecked: YEAR_AGO, latestVersion: "999.0.0" },
};

function createStore(state: { lastChecked: string; latestVersion: string | null }) {
  return { load: mock(async () => state), save: mock(async () => {}) };
}

function enforcingDistribution(): () => void {
  const previous = getActiveDistribution();
  setActiveDistribution({
    ...previous,
    config: { ...previous.config, update: { enforce: true } },
  });
  return () => setActiveDistribution(previous);
}

beforeEach(() => {
  originalPolicy = process.env[UPDATE_POLICY_ENV];
  stderrChunks = [];
  registryLookups = 0;
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  publicNpmDeps.execFile = mock(async () => {
    registryLookups++;
    return { stdout: "999.0.0\n", stderr: "" };
  });
  updateCheckerDeps.now = () => Date.now();
  updateCheckerDeps.toIsoString = () => new Date().toISOString();
  resetUpdatePolicyReport();
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  publicNpmDeps.execFile = originalExecFile;
  updateCheckerDeps.now = originalNow;
  updateCheckerDeps.toIsoString = originalToIsoString;
  if (originalPolicy === undefined) delete process.env[UPDATE_POLICY_ENV];
  else process.env[UPDATE_POLICY_ENV] = originalPolicy;
  mock.restore();
});

describe("pinned update policy", () => {
  for (const [label, cache] of Object.entries(CACHES)) {
    test(`does not enforce, warn, check, or touch update state with a ${label} cache`, async () => {
      process.env[UPDATE_POLICY_ENV] = "pinned";
      const restore = enforcingDistribution();
      const store = createStore(cache);

      try {
        expect(await enforceUpdateIfRequired(store as never)).toBe(false);
        await showUpdateBannerIfAvailable(store as never);
        await scheduleBackgroundCheck(store as never);
      } finally {
        restore();
      }

      expect(store.load).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      expect(registryLookups).toBe(0);
      expect(stderrChunks.join("")).toBe("");
    });
  }

  test("a command runs with the registry unreachable and update state unreadable", async () => {
    process.env[UPDATE_POLICY_ENV] = "pinned";
    const restore = enforcingDistribution();
    publicNpmDeps.execFile = mock(async () => {
      throw new Error("outbound networking is disabled");
    });
    const readOnlyStore = {
      load: async () => {
        throw new Error("EACCES: update state is read-only");
      },
      save: async () => {
        throw new Error("EROFS: update state is read-only");
      },
    };

    try {
      expect(await enforceUpdateIfRequired(readOnlyStore as never)).toBe(false);
      await showUpdateBannerIfAvailable(readOnlyStore as never);
      await scheduleBackgroundCheck(readOnlyStore as never);
    } finally {
      restore();
    }

    expect(stderrChunks.join("")).toBe("");
  });
});

describe("update policy is opt-in and validated", () => {
  test("absent, enforcement, banner, and background check behave exactly as before", async () => {
    delete process.env[UPDATE_POLICY_ENV];
    const restore = enforcingDistribution();
    const store = createStore(CACHES.newer);

    try {
      expect(isPinnedDeployment()).toBe(false);
      expect(await enforceUpdateIfRequired(store as never)).toBe(true);
      await showUpdateBannerIfAvailable(store as never);
      await scheduleBackgroundCheck(store as never);
    } finally {
      restore();
    }

    expect(stderrChunks.join("")).toContain("update required");
    expect(stderrChunks.join("")).toContain("update available");
    expect(store.save).toHaveBeenCalled();
    expect(registryLookups).toBe(1);
  });

  test("an empty value is not a declaration", () => {
    process.env[UPDATE_POLICY_ENV] = "   ";

    expect(getUpdatePolicy()).toBe("default");
    expect(stderrChunks.join("")).toBe("");
  });

  test("an unrecognized value is reported naming the setting and the value, and is not pinned", async () => {
    process.env[UPDATE_POLICY_ENV] = "immutable";
    const restore = enforcingDistribution();
    const store = createStore(CACHES.newer);

    try {
      expect(getUpdatePolicy()).toBe("default");
      expect(await enforceUpdateIfRequired(store as never)).toBe(true);
    } finally {
      restore();
    }

    const stderr = stderrChunks.join("");
    expect(stderr).toContain(UPDATE_POLICY_ENV);
    expect(stderr).toContain("immutable");
  });

  test("an unrecognized value is reported once per process", () => {
    process.env[UPDATE_POLICY_ENV] = "immutable";

    getUpdatePolicy();
    getUpdatePolicy();

    expect(stderrChunks.filter((chunk) => chunk.includes(UPDATE_POLICY_ENV))).toHaveLength(1);
  });
});
