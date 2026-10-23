import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { renderToString } from "ink";

import { renderBanner } from "../cli/commands/companion/tui";
import { main, type MainDeps } from "../cli/main";
import { resetActiveDistribution, setActiveDistribution } from "../distribution";
import { buildBanner } from "../hooks/session-banner";
import { WizardHeader } from "../lib/components/wizard-header";
import { PluginRegistry } from "../tools/setup/registry";
import { LOGO_ART } from "./art.generated";

/** True when the text carries any row of the logo, in block or ASCII form. */
function containsLogoArt(text: string): boolean {
  if (/[█▀▄]/.test(text)) return true;
  return Object.values(LOGO_ART).some((art) =>
    art.ascii.some((row) => row.trim().length >= 8 && text.includes(row.trim())),
  );
}

const deps: MainDeps = {
  ensureUnambiguousCompanion: async () => true,
  inspectInstallPreflight: async () => ({ ok: true }),
  hydrateDynamicPlugins: async () => {},
  resolveRootContext: async () => {
    throw new Error("not reached");
  },
  refreshRuntimeDirectory: async () => ({ changed: [] }),
};

describe("terminal output carries no logo art", () => {
  beforeEach(() => {
    setActiveDistribution({
      config: { runtime: "bun", version: "test" },
      registry: new PluginRegistry([]),
    });
  });

  afterEach(() => {
    resetActiveDistribution();
  });

  test("A routine command stays quiet: --help and --version print no logo art", async () => {
    const printed: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.join(" "));
    });
    const write = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    }) as never);
    try {
      await main(["node", "mate", "--help"], deps);
      await main(["node", "mate", "--version"], deps);
    } finally {
      log.mockRestore();
      write.mockRestore();
    }

    expect(printed.join("\n").length).toBeGreaterThan(0);
    expect(containsLogoArt(printed.join("\n"))).toBe(false);
  });

  test("the companion tui banner and the wizard header stay text", () => {
    expect(containsLogoArt(renderBanner("/work/acme", "/companions/acme"))).toBe(false);
    expect(
      containsLogoArt(renderToString(<WizardHeader title="Agents" step={0} totalSteps={4} />)),
    ).toBe(false);
  });

  test("Agent session banner stays text", async () => {
    const outcome = await buildBanner({
      MATE_REPO_PATH: "/work/acme",
      MATE_ARTIFACT_PATH: "/companions/acme-companion",
      MATE_VERSION: "1.2.3",
    });
    const { systemMessage } = JSON.parse(outcome.stdout) as { systemMessage: string };

    expect(systemMessage).toContain("mate v1.2.3");
    expect(containsLogoArt(systemMessage)).toBe(false);
  });

  test("the detector recognises every logo form", () => {
    for (const art of Object.values(LOGO_ART)) {
      expect(containsLogoArt(art.ascii.join("\n"))).toBe(true);
      expect(
        containsLogoArt(art.block.map((row) => row.map((s) => s.text).join("")).join("\n")),
      ).toBe(true);
    }
  });
});
