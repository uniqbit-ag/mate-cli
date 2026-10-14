import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { instructionBlockKey } from "./context-services";
import {
  contributionLedgerPath,
  ledgerFromInputs,
  ledgerTeardownInput,
  readContributionLedger,
  writeContributionLedger,
  type ContributionLedger,
} from "./contribution-ledger";
import type { CapabilityContributionInput } from "./plugin";

const tempRoots: string[] = [];

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "contribution-ledger-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function input(
  pluginId: string,
  enabled: boolean,
  contributions: CapabilityContributionInput["contributions"],
): CapabilityContributionInput {
  return { pluginId, enabled, capabilityEnabled: enabled, contributions };
}

const ZETA = input("zeta", true, {
  mcpServers: [{ name: "zeta-mcp", command: "zeta", env: { ZETA_TOKEN: "secret-value" } }],
  guidanceSections: [{ content: "Zeta guidance." }],
  skillTrees: [{ name: "zeta-skill", sourceDir: "/src/zeta" }],
  agentDefinitions: [{ name: "zeta-agent", content: "prompt" }],
  hookGroups: [
    {
      event: "PreToolUse",
      marker: "zeta-hook.sh",
      group: { hooks: [{ type: "command", command: "zeta-hook.sh --token secret-value" }] },
    },
  ],
  permissionEntries: ["Bash(zeta:*)", "Bash(alpha:*)"],
  pluginReferences: [{ reference: "zeta-plugin@1.0.0", isManagedReference: () => false }],
});

describe("contribution ledger", () => {
  test("records identities of enabled inputs per runtime and owner, never values", () => {
    const ledger = ledgerFromInputs(
      new Map([
        ["opencode", [ZETA]],
        ["claude", [ZETA, input("alpha", false, { mcpServers: [{ name: "alpha-mcp" }] })]],
      ]),
    );

    expect(Object.keys(ledger.runtimes)).toEqual(["claude", "opencode"]);
    expect(ledger.runtimes.claude).toEqual({
      zeta: {
        agentDefinitions: ["zeta-agent"],
        guidanceKeys: [instructionBlockKey("zeta", "Zeta guidance.")],
        hookMarkers: ["zeta-hook.sh"],
        mcpServers: ["zeta-mcp"],
        permissionEntries: ["Bash(alpha:*)", "Bash(zeta:*)"],
        pluginReferences: ["zeta-plugin@1.0.0"],
        skillTrees: ["zeta-skill"],
      },
    });
    expect(JSON.stringify(ledger)).not.toContain("secret-value");
    expect(JSON.stringify(ledger)).not.toContain("/src/zeta");
  });

  test("an absent or unreadable ledger reads as none", async () => {
    const companionPath = await makeCompanion();
    expect(await readContributionLedger(companionPath)).toBeNull();

    await fs.mkdir(path.dirname(contributionLedgerPath(companionPath)), { recursive: true });
    await fs.writeFile(contributionLedgerPath(companionPath), "{ not json", "utf8");
    expect(await readContributionLedger(companionPath)).toBeNull();
  });

  test("writes stable, sorted formatting and round-trips", async () => {
    const companionPath = await makeCompanion();
    const ledger: ContributionLedger = {
      version: 1,
      runtimes: {
        opencode: { b: { mcpServers: ["y", "x"] }, a: { skillTrees: ["s"] } },
        claude: {},
      },
      unswept: ["@z/p", "@a/p"],
    };

    await writeContributionLedger(companionPath, ledger);
    const text = await fs.readFile(contributionLedgerPath(companionPath), "utf8");

    expect(text).toBe(
      `${JSON.stringify(
        {
          version: 1,
          runtimes: { opencode: { a: { skillTrees: ["s"] }, b: { mcpServers: ["x", "y"] } } },
          unswept: ["@a/p", "@z/p"],
        },
        null,
        2,
      )}\n`,
    );
    expect(await readContributionLedger(companionPath)).toEqual({
      version: 1,
      runtimes: { opencode: { a: { skillTrees: ["s"] }, b: { mcpServers: ["x", "y"] } } },
      unswept: ["@a/p", "@z/p"],
    });
  });

  test("a recorded owner becomes a disabled input naming every recorded identity", () => {
    const recorded = ledgerFromInputs(new Map([["claude", [ZETA]]])).runtimes.claude!.zeta!;
    const teardown = ledgerTeardownInput("zeta", recorded);

    expect(teardown.enabled).toBe(false);
    expect(teardown.capabilityEnabled).toBe(false);
    expect(teardown.contributions.mcpServers?.map((server) => server.name)).toEqual(["zeta-mcp"]);
    expect(teardown.contributions.guidanceSections).toHaveLength(1);
    expect(teardown.contributions.skillTrees?.map((tree) => tree.name)).toEqual(["zeta-skill"]);
    expect(teardown.contributions.agentDefinitions?.map((agent) => agent.name)).toEqual([
      "zeta-agent",
    ]);
    expect(teardown.contributions.hookGroups?.map((hook) => hook.marker)).toEqual(["zeta-hook.sh"]);
    expect(teardown.contributions.permissionEntries).toEqual(["Bash(alpha:*)", "Bash(zeta:*)"]);
    const reference = teardown.contributions.pluginReferences?.[0];
    expect(reference?.isManagedReference("zeta-plugin@1.0.0")).toBe(true);
    expect(reference?.isManagedReference("other")).toBe(false);
  });
});
