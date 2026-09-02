import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import packageJson from "../../package.json";
import {
  buildInstallPlan,
  getInstallStatePath,
  INSTALL_CONTRACT_REVISION,
  isRepairableInstallPreflight,
  InstallStateStore,
  inspectInstallPreflight,
  inspectInstallPlan,
  installStateStoreForContext,
  invalidateInstallState,
  readInstallState,
  repairInstallState,
  resolveInstallContext,
  runInstallPlan,
  saveCompleteInstallState,
} from "./install";

const tempRoots: string[] = [];
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
const originalHome = process.env.HOME;

beforeEach(() => {
  process.env.MATE_ARTIFACT_PATH = "";
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-install-"));
  tempRoots.push(root);
  return root;
}

describe("install context and planning", () => {
  test("falls back to a core-only context without a companion", async () => {
    const context = await resolveInstallContext(await tempRoot());
    expect(context.kind).toBe("core");
    expect(context.config.packageManagers).toEqual([]);
    expect(context.config.capabilities).toEqual([]);
  });

  test("classifies local working and hub roots explicitly", async () => {
    const workingRoot = await tempRoot();
    const hubRoot = await tempRoot();
    const writeConfig = async (root: string, type: string): Promise<void> => {
      const configDir = path.join(root, ".mate", "config");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "framework.yaml"),
        [
          `type: ${type}`,
          "allowedAgents: []",
          ...(type === "hub" ? ["hub:", "  companions: []"] : []),
          "",
        ].join("\n"),
      );
    };

    await writeConfig(workingRoot, "working");
    await writeConfig(hubRoot, "hub");

    const working = await resolveInstallContext(workingRoot);
    const hub = await resolveInstallContext(hubRoot);

    expect(working.kind).toBe("working");
    expect(working.companionPath).toBeUndefined();
    expect(hub.kind).toBe("hub");
    expect(hub.companionPath).toBe(hubRoot);
    expect(getInstallStatePath(working)).toBe(getInstallStatePath({ kind: "core" }));
    expect(getInstallStatePath(hub)).not.toBe(getInstallStatePath({ kind: "core" }));
  });

  test("resolves a parent-configured root from a subdirectory", async () => {
    const root = await tempRoot();
    const configDir = path.join(root, ".mate", "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "framework.yaml"),
      ["type: companion", "allowedAgents: [claude]", ""].join("\n"),
    );
    const nested = path.join(root, "src", "deep");
    await fs.mkdir(nested, { recursive: true });

    const context = await resolveInstallContext(nested);

    expect(context.kind).toBe("companion");
    expect(context.companionPath).toBe(root);
  });

  test("plans selected companion dependencies and excludes unselected capabilities", async () => {
    const root = await tempRoot();
    const configDir = path.join(root, ".mate", "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "framework.yaml"),
      [
        "type: companion",
        "allowedAgents: [claude]",
        "packageManagers: [bun, uv]",
        "capabilities:",
        "  - name: openspec",
        "",
      ].join("\n"),
    );

    const context = await resolveInstallContext(root);
    const requirements = buildInstallPlan(context).requirements;
    const ids = requirements.map((requirement) => requirement.id);
    expect(ids).toContain("core:bun");
    expect(ids).toContain("core:uv");
    expect(requirements.find((requirement) => requirement.id === "core:uv")).toEqual(
      expect.objectContaining({ group: "core", source: "Mate package manager" }),
    );
    expect(ids).toContain("capability:openspec");
    expect(ids).not.toContain("capability:graphify");
    expect(ids).not.toContain("capability:rtk");
  });

  test("plans RTK only when the RTK capability is selected", async () => {
    const root = await tempRoot();
    const context = {
      kind: "companion" as const,
      companionPath: root,
      config: {
        allowedAgents: ["claude"],
        packageManagers: ["bun", "uv"],
        capabilities: [{ name: "rtk" }],
      },
      fingerprint: "rtk-context",
    };

    const ids = buildInstallPlan(context).requirements.map((requirement) => requirement.id);
    expect(ids).toContain("capability:rtk");
  });
});

describe("install execution and state", () => {
  test("skips satisfied requirements and verifies installed requirements", async () => {
    let installs = 0;
    let available = true;
    const plan = {
      context: {
        kind: "core" as const,
        config: {} as never,
        fingerprint: "context",
      },
      fingerprint: "requirements",
      requirements: [
        {
          id: "test:tool",
          label: "Test tool",
          group: "core" as const,
          source: "test",
          command: "install test-tool",
          satisfied: true,
          detect: () => available,
          install: async () => {
            installs++;
            available = true;
          },
          verify: () => available,
        },
      ],
    };

    const result = await runInstallPlan(plan);
    expect(result).toEqual({
      ok: true,
      results: [{ id: "test:tool", status: "skipped", verified: true }],
    });
    expect(installs).toBe(0);
  });

  test("returns a failed result when verification cannot pass", async () => {
    const plan = {
      context: { kind: "core" as const, config: {} as never, fingerprint: "context" },
      fingerprint: "requirements",
      requirements: [
        {
          id: "test:missing",
          label: "Missing test tool",
          group: "core" as const,
          source: "test",
          command: "install missing-tool",
          satisfied: false,
          detect: () => false,
          install: async () => {},
          verify: () => false,
        },
      ],
    };

    const result = await runInstallPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({
      id: "test:missing",
      status: "failed",
      verified: false,
    });
  });

  test("persists a revisioned complete state and preflight accepts it", async () => {
    const root = await tempRoot();
    const store = new InstallStateStore(path.join(root, "install-state.yaml"));
    const context = await resolveInstallContext(root);
    const plan = buildInstallPlan(context);
    const inspected = await inspectInstallPlan(plan);
    const execution = await runInstallPlan(inspected);
    expect(execution.ok).toBe(true);
    await saveCompleteInstallState(inspected, execution.results, store);
    const state = await readInstallState(store);
    expect(state?.contractRevision).toBe(INSTALL_CONTRACT_REVISION);

    const preflight = await inspectInstallPreflight(root, { stateStore: store });
    expect(preflight.ok).toBe(true);
  });

  test("repairs a satisfied plan with the same skipped results as install", async () => {
    const home = await tempRoot();
    process.env.HOME = home;
    const context = { kind: "core" as const, config: {} as never, fingerprint: "context" };
    const plan = {
      context,
      fingerprint: "requirements",
      requirements: [
        {
          id: "test:tool",
          label: "Test tool",
          group: "core" as const,
          source: "test",
          command: "install test-tool",
          satisfied: true,
          detect: () => true,
          install: async () => {
            throw new Error("repair must not install");
          },
        },
      ],
    };

    const execution = await runInstallPlan(plan);
    await repairInstallState(plan);
    const repaired = await readInstallState(new InstallStateStore(getInstallStatePath(context)));

    expect(execution.results).toEqual([{ id: "test:tool", status: "skipped", verified: true }]);
    expect(repaired?.requirements).toEqual(execution.results);
    expect(repaired).toMatchObject({
      contractRevision: INSTALL_CONTRACT_REVISION,
      contextFingerprint: "context",
      requirementFingerprint: "requirements",
    });
  });

  test("repair state passes a following preflight without running installers", async () => {
    const home = await tempRoot();
    process.env.HOME = home;
    const root = await tempRoot();
    const context = await resolveInstallContext(root);
    const plan = await inspectInstallPlan(buildInstallPlan(context));
    const installs = plan.requirements.map((item) => {
      item.install = async () => {
        throw new Error("repair must not install");
      };
      return item;
    });
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error("repair must not use the network");
    };

    try {
      await repairInstallState(plan);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(installs).toHaveLength(plan.requirements.length);
    expect(requests).toBe(0);
    expect((await inspectInstallPreflight(root)).ok).toBe(true);
  });

  test("repeating a repair over the same plan keeps the recorded state stable", async () => {
    const home = await tempRoot();
    process.env.HOME = home;
    const plan = {
      context: { kind: "core" as const, config: {} as never, fingerprint: "context" },
      fingerprint: "requirements",
      requirements: [],
    };

    await repairInstallState(plan);
    const first = await readInstallState(new InstallStateStore(getInstallStatePath(plan.context)));
    await repairInstallState(plan);
    const second = await readInstallState(new InstallStateStore(getInstallStatePath(plan.context)));

    expect(second).toEqual(first);
  });

  test("inspection reports a missing state without writing one", async () => {
    const home = await tempRoot();
    process.env.HOME = home;
    const root = await tempRoot();
    const context = await resolveInstallContext(root);
    const store = new InstallStateStore(path.join(home, "install-state.yaml"));

    const preflight = await inspectInstallPreflight(root, { stateStore: store });

    expect(preflight.ok).toBe(false);
    await expect(readInstallState(store)).resolves.toBeNull();
  });

  test("hub contents do not invalidate install state", async () => {
    const root = await tempRoot();
    const configDir = path.join(root, ".mate", "config");
    const configPath = path.join(configDir, "framework.yaml");
    const store = new InstallStateStore(path.join(root, "install-state.yaml"));
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      configPath,
      ["type: hub", "allowedAgents: []", "hub:", "  companions: []", ""].join("\n"),
    );
    const context = await resolveInstallContext(root);
    const plan = buildInstallPlan(context);
    await saveCompleteInstallState(plan, [], store);

    await fs.writeFile(
      configPath,
      [
        "type: hub",
        "allowedAgents: []",
        "hub:",
        "  companions:",
        "    - id: acme",
        "      path: companions/acme",
        "      source:",
        "        kind: local",
        "        path: ../acme",
        "",
      ].join("\n"),
    );

    const preflight = await inspectInstallPreflight(root, { stateStore: store });
    expect(preflight.ok).toBe(true);
  });

  test("keeps install state separate for multiple companions", async () => {
    const root = await tempRoot();
    const stateRoot = path.join(root, "install-state");
    const contextA = {
      kind: "companion" as const,
      companionPath: path.join(root, "companion-a"),
      config: {} as never,
      fingerprint: "companion-a",
    };
    const contextB = {
      kind: "companion" as const,
      companionPath: path.join(root, "companion-b"),
      config: {} as never,
      fingerprint: "companion-b",
    };
    const planA = { context: contextA, requirements: [], fingerprint: "requirements-a" };
    const planB = { context: contextB, requirements: [], fingerprint: "requirements-b" };
    const storeA = installStateStoreForContext(contextA, stateRoot);
    const storeB = installStateStoreForContext(contextB, stateRoot);

    expect(getInstallStatePath(contextA, stateRoot)).not.toBe(
      getInstallStatePath(contextB, stateRoot),
    );

    await saveCompleteInstallState(planA, [], storeA);
    await saveCompleteInstallState(planB, [], storeB);

    expect((await readInstallState(storeA))?.contextFingerprint).toBe("companion-a");
    expect((await readInstallState(storeB))?.contextFingerprint).toBe("companion-b");

    await invalidateInstallState(contextA, storeA);
    expect(await readInstallState(storeA)).toBeNull();
    expect((await readInstallState(storeB))?.contextFingerprint).toBe("companion-b");
  });
});

describe("install preflight repairability", () => {
  test("depends on the inspected plan rather than the reason", () => {
    const plan = {
      context: { kind: "core" as const, config: {} as never, fingerprint: "context" },
      requirements: [
        {
          id: "test:tool",
          label: "Test tool",
          group: "core" as const,
          source: "test",
          command: "install test-tool",
          satisfied: true,
          detect: () => true,
          install: async () => {},
        },
      ],
      fingerprint: "requirements",
    };

    expect(isRepairableInstallPreflight({ ok: false, reason: "reworded", plan })).toBe(true);
    expect(isRepairableInstallPreflight({ ok: true, plan })).toBe(false);
    expect(isRepairableInstallPreflight({ ok: false, reason: "missing" })).toBe(false);
    expect(
      isRepairableInstallPreflight({
        ok: false,
        reason: "ambiguous",
        plan: { ...plan, context: { ...plan.context, kind: "ambiguous" } },
      }),
    ).toBe(false);
    expect(
      isRepairableInstallPreflight({
        ok: false,
        reason: "missing requirement",
        plan: {
          ...plan,
          requirements: [{ ...plan.requirements[0]!, satisfied: false }],
        },
      }),
    ).toBe(false);
  });
});

describe("engines.mate version guard", () => {
  async function writeCompanionConfig(root: string, enginesYaml: string): Promise<string> {
    const configDir = path.join(root, ".mate", "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "framework.yaml"),
      ["type: companion", "allowedAgents: [claude]", enginesYaml, ""].join("\n"),
    );
    return root;
  }

  test("blocks when engines.mate is unsatisfied", async () => {
    const root = await tempRoot();
    await writeCompanionConfig(root, 'engines:\n  mate: ">=99.0.0"');

    const preflight = await inspectInstallPreflight(root);
    expect(preflight.ok).toBe(false);
    expect(preflight.reason).toContain(">=99.0.0");
    expect(preflight.reason).toContain(packageJson.version);
    expect(preflight.plan).toBeUndefined();
    expect(isRepairableInstallPreflight(preflight)).toBe(false);
  });

  test("blocks with a distinct message when engines.mate is an invalid range", async () => {
    const root = await tempRoot();
    await writeCompanionConfig(root, 'engines:\n  mate: ">=0.x.y"');

    const preflight = await inspectInstallPreflight(root);
    expect(preflight.ok).toBe(false);
    expect(preflight.reason).toContain(">=0.x.y");
    expect(preflight.reason).not.toContain(packageJson.version);
  });

  test("does not repair an ambiguous companion preflight", async () => {
    const root = await tempRoot();
    const working = path.join(root, "working");
    const companions = [path.join(root, "companion-a"), path.join(root, "companion-b")];
    await fs.mkdir(path.join(working, ".mate", "config"), { recursive: true });
    for (const companion of companions) {
      await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
      await fs.writeFile(
        path.join(companion, ".mate", "config", "framework.yaml"),
        "type: companion\nallowedAgents: []\n",
      );
    }
    await fs.writeFile(
      path.join(working, ".mate", "config", "registry.yaml"),
      [
        "repository:",
        "  id: working",
        `  path: ${working}`,
        "  profile: default",
        "companions:",
        ...companions.flatMap((companion) => [
          `  - path: ${companion}`,
          "    repositoryId: working",
          "    source: existing",
        ]),
        "",
      ].join("\n"),
    );

    const preflight = await inspectInstallPreflight(working);

    expect(preflight.ok).toBe(false);
    expect(preflight.plan?.context.kind).toBe("ambiguous");
    expect(isRepairableInstallPreflight(preflight)).toBe(false);
  });

  test("proceeds to existing checks when engines.mate is satisfied", async () => {
    const root = await tempRoot();
    await writeCompanionConfig(root, 'engines:\n  mate: ">=0.0.0"');

    const preflight = await inspectInstallPreflight(root);
    expect(preflight.ok).toBe(false);
    expect(preflight.plan).toBeDefined();
    expect(preflight.reason).not.toContain(">=0.0.0");
  });

  test("proceeds to existing checks when engines.mate is absent", async () => {
    const root = await tempRoot();
    await writeCompanionConfig(root, "packageManagers: []");

    const preflight = await inspectInstallPreflight(root);
    expect(preflight.ok).toBe(false);
    expect(preflight.plan).toBeDefined();
  });

  test("version-check reason wins over a simultaneously-stale context fingerprint", async () => {
    const root = await tempRoot();
    await writeCompanionConfig(root, 'engines:\n  mate: ">=99.0.0"');
    const store = new InstallStateStore(path.join(root, "install-state.yaml"));
    await store.save({
      contractRevision: INSTALL_CONTRACT_REVISION,
      mateVersion: packageJson.version,
      completedAt: new Date().toISOString(),
      contextFingerprint: "stale-fingerprint",
      requirementFingerprint: "stale-requirements",
      requirements: [],
    });

    const preflight = await inspectInstallPreflight(root, { stateStore: store });
    expect(preflight.ok).toBe(false);
    expect(preflight.reason).toContain(">=99.0.0");
    expect(preflight.reason).not.toContain("installation context has changed");
  });
});
