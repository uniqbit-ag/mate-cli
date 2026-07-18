import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildInstallPlan,
  getInstallStatePath,
  INSTALL_CONTRACT_REVISION,
  InstallStateStore,
  inspectInstallPreflight,
  installStateStoreForContext,
  invalidateInstallState,
  readInstallState,
  resolveInstallContext,
  runInstallPlan,
  saveCompleteInstallState,
} from "./install";

const tempRoots: string[] = [];
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;

beforeEach(() => {
  process.env.MATE_ARTIFACT_PATH = "";
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
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

  test("plans selected companion dependencies and excludes unselected capabilities", async () => {
    const root = await tempRoot();
    const configDir = path.join(root, ".mate", "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "framework.yaml"),
      [
        "type: companion",
        "profiles:",
        "  default:",
        "    name: default",
        "    allowedAgents: [claude]",
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
    expect(ids).not.toContain("capability:headroom");
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
    const inspected = await (await import("./install")).inspectInstallPlan(plan);
    const execution = await runInstallPlan(inspected);
    expect(execution.ok).toBe(true);
    await saveCompleteInstallState(inspected, execution.results, store);
    const state = await readInstallState(store);
    expect(state?.contractRevision).toBe(INSTALL_CONTRACT_REVISION);

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
