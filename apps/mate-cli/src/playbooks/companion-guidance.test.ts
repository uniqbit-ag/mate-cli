import { describe, expect, test } from "bun:test";

import {
  buildCompanionGuidance,
  GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT,
} from "./companion-guidance";
import { getWrapperBinPath } from "../lib/package-paths";

describe("buildCompanionGuidance", () => {
  test("mentions gitignored local-only working-repo artifacts", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain("gitignored");
    expect(guidance).toContain("local-only");
  });

  test("includes shared Graphify guidance when capability is enabled", () => {
    const guidance = buildCompanionGuidance({
      capabilities: [{ name: "graphify" }],
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain('<codebase-exploration-rules priority="mandatory">');
    expect(guidance).toContain(GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT);
    expect(guidance).toContain("graphify query");
    expect(guidance).toContain("graphify -> grep/glob/read");
    expect(guidance).toContain("MUST try graphify before raw source");
    expect(guidance).not.toContain("This project has a knowledge graph at graphify-out/");
  });

  test("uses the tokensave-first graphify guidance only when tokensave capability is enabled", () => {
    const guidance = buildCompanionGuidance({
      capabilities: [{ name: "graphify" }, { name: "tokensave" }],
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain("tokensave_context");
    expect(guidance).toContain("tokensave -> graphify -> grep/glob/read");
    expect(guidance).toContain("MUST NOT skip steps");
  });

  test("includes tokensave-only exploration guidance when graphify capability is disabled", () => {
    const guidance = buildCompanionGuidance({
      capabilities: [{ name: "tokensave" }],
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain('<codebase-exploration-rules priority="mandatory">');
    expect(guidance).toContain("tokensave_context");
    expect(guidance).toContain("tokensave -> grep/glob/read");
    expect(guidance).toContain("MUST try tokensave before raw source");
    expect(guidance).toContain("mate cap index --tokensave");
    expect(guidance).not.toContain(GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT);
    expect(guidance).not.toContain("tokensave -> graphify -> grep/glob/read");
    expect(guidance).not.toContain("GRAPH_REPORT.md");
  });

  test("omits allowed-agent policy echo from prompt guidance", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: { allowedAgents: ["claude", "opencode"] },
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).not.toContain("<runtime-policy ");
    expect(guidance).not.toContain('"allowedAgents"');
    expect(guidance).not.toContain("Allowed agents are");
  });

  test("omits policy element when policy is empty", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).not.toContain("<runtime-policy ");
  });

  test("wraps guidance in a mandatory companion-policy XML element", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain('<companion-policy framework="mate" priority="mandatory">');
    expect(guidance).toContain("<mandatory-rules>");
    expect(guidance).toContain('severity="critical"');
    expect(guidance).toContain("</companion-policy>");
    expect(guidance).toContain(
      '<path role="working-repository" env="MATE_REPO_PATH">/tmp/working</path>',
    );
    expect(guidance).toContain('<linked-repository id="app" profile="default" />');
  });

  test("uses intent-based artifact framing, not file extensions", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain("Agent artifacts MUST go to /tmp/companion");
    expect(guidance).toContain("Product code (README, docs, source, tests)");
    expect(guidance).not.toContain("*.md");
  });

  test("includes concrete path contract with env vars", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain("MATE_REPO_PATH");
    expect(guidance).toContain("MATE_ARTIFACT_PATH");
    expect(guidance).toContain("MATE_WRAPPER_BIN_PATH");
    expect(guidance).toContain(getWrapperBinPath());
    expect(guidance).toContain("Agent artifacts MUST go to /tmp/companion, NEVER /tmp/working");
  });

  test("tells the agent to use explicit companion wrapper paths for companion-managed CLIs", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain("<cli-tools>");
    expect(guidance).toContain('name="openspec" type="wrapper"');
    expect(guidance).toContain('name="graphify" type="wrapper"');
    expect(guidance).toContain(`${getWrapperBinPath()}/openspec`);
    expect(guidance).toContain(`${getWrapperBinPath()}/graphify`);
    expect(guidance).toContain('name="mate" type="global"');
  });

  test("allows wrapper paths to be represented by the launch environment", () => {
    const guidance = buildCompanionGuidance(
      {
        companionPath: "$MATE_ARTIFACT_PATH",
        policy: {},
        repository: {
          id: "$MATE_REPO_ID",
          path: "$MATE_REPO_PATH",
          profile: "$MATE_REPO_PROFILE",
        },
      } as never,
      { wrapperBinPath: "$MATE_WRAPPER_BIN_PATH" },
    );

    expect(guidance).toContain(
      '<path role="package-wrapper-bin" env="MATE_WRAPPER_BIN_PATH">$MATE_WRAPPER_BIN_PATH</path>',
    );
    expect(guidance).toContain('invokeAs="$MATE_WRAPPER_BIN_PATH/openspec"');
    expect(guidance).toContain('invokeAs="$MATE_WRAPPER_BIN_PATH/graphify"');
    expect(guidance).not.toContain(getWrapperBinPath());
  });

  test("includes cli-tools with explicit invokeAs per tool", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain('<cli name="mate" type="global" invokeAs="mate" />');
  });

  test("forbids bare invocation of companion-managed CLIs", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain('id="wrapper-only-cli-execution"');
    expect(guidance).toContain("invoke the exact path in its invokeAs attribute");
    expect(guidance).toContain("Correct: ");
    expect(guidance).toContain("Incorrect: openspec status ...");
    expect(guidance).toContain("Do not run bare openspec or graphify commands");
    expect(guidance).toContain("do not rely on PATH, aliases, or shell functions");
    expect(guidance).toContain("If the exact wrapper path is unavailable, stop and report it");
  });

  test("uses mandatory framing", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
        profile: "default",
      },
    } as never);

    expect(guidance).toContain("MANDATORY RULES");
    expect(guidance).toContain("NON-NEGOTIABLE");
  });
});
