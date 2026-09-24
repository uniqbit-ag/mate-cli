import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../distribution";
import {
  UPDATE_POLICY_ENV,
  UpdateStateStore,
  resetUpdatePolicyReport,
} from "../lib/update-checker";
import type { RootContext } from "../lib/orchestrator/root-context";
import { PluginRegistry } from "../tools/setup/registry";
import * as companionCmd from "./commands/companion/companion";
import * as studioCmd from "./commands/studio";
import * as opencodeCmd from "./commands/launch/opencode";
import * as updateCmd from "./commands/update";
import * as doctorCmd from "./commands/doctor";
import { main, type MainDeps } from "./main";

const spies: Array<{ mockRestore: () => void }> = [];
let dispatched: string[];
let originalPolicy: string | undefined;
let stderr: string;
let registryLoads: number;

function coreRootContext(): RootContext {
  return {
    kind: "core",
    origin: "none",
    linkedRepository: null,
    resolution: { match: null, ambiguousMatches: [], failures: [] },
  };
}

function deps(overrides: { companion?: boolean } = {}): MainDeps {
  return {
    ensureUnambiguousCompanion: async () => overrides.companion ?? true,
    inspectInstallPreflight: async () => ({ ok: true }),
    repairInstallState: async () => {},
    hydrateDynamicPlugins: async () => {},
    resolveRootContext: async () => coreRootContext(),
  };
}

beforeEach(() => {
  process.exitCode = 0;
  dispatched = [];
  stderr = "";
  registryLoads = 0;
  originalPolicy = process.env[UPDATE_POLICY_ENV];
  resetUpdatePolicyReport();
  /** An enforcing distribution with a newer version cached: the state a pinned deployment is stuck in. */
  setActiveDistribution({
    config: { runtime: "bun", version: "1.0.0", update: { enforce: true } },
    registry: new PluginRegistry([]),
  });
  const record = (name: string) => async () => {
    dispatched.push(name);
  };
  spies.push(
    spyOn(companionCmd, "runCompanionCommand").mockImplementation(record("companion")),
    spyOn(studioCmd, "runStudioCommand").mockImplementation(record("studio")),
    spyOn(opencodeCmd, "runLaunchOpenCodeCommand").mockImplementation(record("opencode")),
    spyOn(updateCmd, "runUpdateCommand").mockImplementation(record("update")),
    spyOn(doctorCmd, "runDoctorCommand").mockImplementation(record("doctor")),
    spyOn(UpdateStateStore.prototype, "load").mockImplementation(async () => {
      registryLoads++;
      return { lastChecked: new Date().toISOString(), latestVersion: "999.0.0" };
    }),
    spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }),
  );
});

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
  resetActiveDistribution();
  process.exitCode = 0;
  if (originalPolicy === undefined) delete process.env[UPDATE_POLICY_ENV];
  else process.env[UPDATE_POLICY_ENV] = originalPolicy;
});

describe("the update gate under the pinned policy", () => {
  const COMMANDS: Array<[string, string[]]> = [
    ["companion", ["companion", "register", "/tmp/acme"]],
    ["companion", ["companion", "prepare", "--from", "/tmp/bundle", "/tmp/acme"]],
    ["opencode", ["opencode"]],
    ["studio", ["studio"]],
  ];

  for (const [name, argv] of COMMANDS) {
    test(`\`mate ${argv.join(" ")}\` dispatches with a newer version cached`, async () => {
      process.env[UPDATE_POLICY_ENV] = "pinned";

      await main(["node", "mate", ...argv], deps());

      expect(dispatched).toEqual([name]);
      expect(process.exitCode ?? 0).toBe(0);
      expect(registryLoads).toBe(0);
      expect(stderr).toBe("");
    });

    test(`\`mate ${argv.join(" ")}\` is blocked without the policy`, async () => {
      delete process.env[UPDATE_POLICY_ENV];

      await main(["node", "mate", ...argv], deps());

      expect(dispatched).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(stderr).toContain("update required");
    });
  }

  test("non-update gates still refuse under the policy", async () => {
    process.env[UPDATE_POLICY_ENV] = "pinned";

    await main(["node", "mate", "opencode"], deps({ companion: false }));

    expect(dispatched).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("default-policy exemptions are unchanged", async () => {
    delete process.env[UPDATE_POLICY_ENV];

    await main(["node", "mate", "update"], deps());
    await main(["node", "mate", "doctor"], deps());

    expect(dispatched).toEqual(["update", "doctor"]);
  });
});
