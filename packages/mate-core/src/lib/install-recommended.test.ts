import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createGraphifyPlugin } from "../tools/setup/capabilities/graphify";
import type { InstallRequirement } from "../tools/setup/install-contract";
import { createUvPlugin } from "../tools/setup/package-managers/uv";
import type { Plugin } from "../tools/setup/plugin";
import {
  buildInstallPlan,
  inspectInstallPlan,
  inspectInstallPreflight,
  InstallStateStore,
  recommendationChoice,
  runInstallPlan,
  saveCompleteInstallState,
  type InstallContext,
} from "./install";
import { MemberChoicesStore, type MemberChoices } from "./member-choices";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function tool(id: string, present: boolean, recommendedBy?: string[]): Plugin {
  const requirement: InstallRequirement = {
    id: `test:${id}`,
    label: id,
    group: "companion",
    source: "test",
    command: `install ${id}`,
    recommendedBy,
    detect: () => present,
    install: async () => {},
  };
  return {
    id,
    kind: "capability",
    label: id,
    description: id,
    defaultSelected: false,
    isEnabled: () => true,
    getInstallRequirements: () => [requirement],
    async apply() {},
    async teardown() {},
  };
}

function context(choices: MemberChoices = {}): InstallContext {
  return {
    kind: "companion",
    companionPath: "/companion",
    config: { allowedAgents: [], capabilities: [] },
    fingerprint: "context",
    choices,
  };
}

async function plan(plugins: Plugin[], choices?: MemberChoices) {
  const inspected = await inspectInstallPlan(buildInstallPlan(context(choices), plugins));
  return {
    active: inspected.requirements.map((item) => item.id).filter((id) => id !== "core:bun"),
    deferred: inspected.deferred.map((item) => `${item.id}:${item.choice}`),
    fingerprint: inspected.fingerprint,
  };
}

describe("recommended install requirements", () => {
  test("a mandatory requirement is always planned", async () => {
    expect((await plan([tool("mandatory", false)])).active).toEqual(["test:mandatory"]);
  });

  test("an undecided, missing recommendation is deferred, never installed", async () => {
    expect(await plan([tool("rtk", false, ["rtk"])])).toMatchObject({
      active: [],
      deferred: ["test:rtk:undecided"],
    });
  });

  test("an undecided recommendation that is already installed stays verified", async () => {
    expect((await plan([tool("rtk", true, ["rtk"])])).active).toEqual(["test:rtk"]);
  });

  test("accepted is planned, declined is deferred even when present", async () => {
    expect((await plan([tool("rtk", false, ["rtk"])], { rtk: "accepted" })).active).toEqual([
      "test:rtk",
    ]);
    expect((await plan([tool("rtk", true, ["rtk"])], { rtk: "declined" })).deferred).toEqual([
      "test:rtk:declined",
    ]);
  });

  test("deferred requirements do not change the plan fingerprint", async () => {
    const base = await plan([tool("mandatory", true)]);
    const withDeferred = await plan([tool("mandatory", true), tool("rtk", false, ["rtk"])]);
    expect(withDeferred.fingerprint).toBe(base.fingerprint);
  });

  test("uv follows the member's Graphify choice", async () => {
    const config = { allowedAgents: [], capabilities: [{ name: "graphify" }] };
    const uv = createUvPlugin({ isCommandOnPath: () => false, installDirs: [], platform: "linux" });
    const graphify = createGraphifyPlugin();
    for (const [choices, expected] of [
      [{}, "undecided"],
      [{ graphify: "declined" }, "declined"],
      [{ graphify: "accepted" }, "accepted"],
    ] as const) {
      const requirements = buildInstallPlan({ ...context(choices), config }, [
        graphify,
        uv,
      ]).requirements;
      const uvRequirement = requirements.find((item) => item.id === "core:uv")!;
      expect(recommendationChoice(uvRequirement, choices)).toBe(expected);
    }
  });

  test("a launch preflight is not blocked by a recommendation the member has not installed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-install-recommended-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".mate", "config", "framework.yaml"),
      "type: companion\nallowedAgents: []\ncapabilities:\n  - name: rtk\n",
    );
    const previous = process.env.MATE_ARTIFACT_PATH;
    const previousPath = process.env.PATH;
    process.env.MATE_ARTIFACT_PATH = root;
    // Bun is there, RTK is not.
    process.env.PATH = path.dirname(process.execPath);
    try {
      const memberChoicesStore = new MemberChoicesStore(path.join(root, "choices.yaml"));
      const stateStore = new InstallStateStore(path.join(root, "install-state.yaml"));
      const { resolveInstallContext } = await import("./install");
      const installed = await inspectInstallPlan(
        buildInstallPlan(await resolveInstallContext(root, { memberChoicesStore })),
      );
      expect(installed.deferred.map((item) => item.id)).toEqual(["capability:rtk"]);
      const execution = await runInstallPlan(installed);
      await saveCompleteInstallState(installed, execution.results, stateStore);

      const preflight = await inspectInstallPreflight(root, { stateStore, memberChoicesStore });
      expect(preflight).toMatchObject({ ok: true });
    } finally {
      if (previous === undefined) delete process.env.MATE_ARTIFACT_PATH;
      else process.env.MATE_ARTIFACT_PATH = previous;
      process.env.PATH = previousPath;
    }
  });
});
