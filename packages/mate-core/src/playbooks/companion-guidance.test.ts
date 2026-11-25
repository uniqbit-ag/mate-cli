import { describe, expect, test } from "bun:test";

import {
  buildCompanionGuidance,
  GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT,
} from "./companion-guidance";
import { getWrapperBinPath } from "../lib/package-paths";
import { FRICTION_GUIDANCE } from "../runtime/companion-guidance";

describe("buildCompanionGuidance", () => {
  test("carries the secret-handling rule while guardrails are active", () => {
    const guidance = buildCompanionGuidance({ companionPath: "/tmp/companion" });

    expect(guidance).toContain('<rule id="secret-handling" severity="critical">');
    expect(guidance).toContain(".env.example");
    expect(guidance).toContain("ask the user");
  });

  test("drops the secret-handling rule after an opt-out", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      secretGuardrails: false,
    });

    expect(guidance).not.toContain("secret-handling");
  });

  test("mentions gitignored local-only working-repo artifacts", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
      },
    } as never);

    expect(guidance).toContain("gitignored");
    expect(guidance).toContain("local-only");
  });

  test("states how the guardrail resolves relative paths", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: { id: "app", path: "/tmp/working" },
    } as never);
    const rule = guidance.split("\n").find((line) => line.includes('<rule id="guardrail"'));

    expect(rule).toContain("resolves relative paths against /tmp/working");
    expect(rule).toContain("does not follow cd");
    expect(rule).toContain("absolute paths under /tmp/companion");
  });

  test("states no path resolution rule without a working repository", () => {
    const guidance = buildCompanionGuidance({ companionPath: "/tmp/companion" });

    expect(guidance).not.toContain("resolves relative paths");
    expect(guidance).not.toContain("does not follow cd");
  });

  test("renders companion-only guidance without working-repository fields", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      capabilities: [{ name: "graphify" }],
    });

    expect(guidance).toContain("Companion-scoped launch with no Working Repository");
    expect(guidance).toContain("Agent artifacts MUST go to /tmp/companion");
    expect(guidance).toContain("__companion__");
    expect(guidance).not.toContain("MATE_REPO_PATH");
    expect(guidance).not.toContain("linked-repository");
  });

  test("includes shared Graphify guidance when capability is enabled", () => {
    const guidance = buildCompanionGuidance({
      capabilities: [{ name: "graphify" }],
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
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

  test("includes the openspec publish rule only when the openspec capability is enabled", () => {
    const withOpenspec = buildCompanionGuidance({
      capabilities: [{ name: "openspec" }],
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
      },
    } as never);

    expect(withOpenspec).toContain('<rule id="openspec-publish" severity="critical">');
    expect(withOpenspec).toContain('mate artifact publish "<name>" --json');
    expect(withOpenspec).toContain("It creates no tag.");
    expect(withOpenspec).toContain("Never hand-commit or hand-tag one.");
    expect(withOpenspec).toContain("submitting is a precondition (mate-submit-change");
    expect(withOpenspec).toContain(
      "is not the truth: only publication lands it on the companion's default branch",
    );
    expect(withOpenspec).toContain(
      "mate artifact pending --json --no-merge-check lists them with author, touched requirements, ref and path",
    );
    expect(withOpenspec).toContain(
      "read one (git show <ref>:<path>/<file>) only where it touches your work or the user names it",
    );
    expect(withOpenspec).toContain('mate artifact take "<name>" brings it into the checkout');
    expect(withOpenspec).toContain("implement or revise one only when the user names it");
    expect(withOpenspec).toContain('mate artifact project "<name>" shows the unpublished outcome');
    expect(withOpenspec).toContain("to the inbox mate/inbox to await its merge");
    expect(withOpenspec).not.toContain("unpublished and not yours");
    expect(withOpenspec).not.toContain("mate-archive-change");
    // The command enforces these itself; the guidance does not repeat them.
    expect(withOpenspec).not.toContain("still-active change is an error");
    expect(withOpenspec).not.toContain("refuses to run anywhere but");

    const withoutOpenspec = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
      },
    } as never);

    expect(withoutOpenspec).not.toContain('id="openspec-publish"');
  });

  test("tells Claude the RTK_DISABLED=1 git form only when RTK is selected", () => {
    const repository = { id: "app", path: "/tmp/working" };
    const withRtk = buildCompanionGuidance({
      capabilities: [{ name: "rtk" }],
      companionPath: "/tmp/companion",
      repository,
    });
    const rule = withRtk.split("\n").find((line) => line.includes('id="entered-worktree-git"'));

    expect(rule).toContain("EnterWorktree");
    expect(rule).toContain("RTK_DISABLED=1 git");
    expect(
      buildCompanionGuidance({
        capabilities: [{ name: "tokensave" }],
        companionPath: "/tmp/companion",
        repository,
      }),
    ).not.toContain("RTK_DISABLED");
  });

  test("explains companion, domain, and repository Area scope", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      repository: {
        id: "app",
        path: "/tmp/working",
      },
    } as never);

    expect(guidance).toContain('id="companion-multi-repository"');
    expect(guidance).toContain("may serve multiple Working Repositories");
    expect(guidance).toContain("session's single primary Working Repository");
    expect(guidance).toContain('id="repository-area-scope"');
    expect(guidance).toContain("repository-relative Area");
    expect(guidance).toContain("Area alone is not a repository identity");
  });

  test("explains OpenSpec repository and Area scope when enabled", () => {
    const guidance = buildCompanionGuidance({
      capabilities: [{ name: "openspec" }],
      companionPath: "/tmp/companion",
      repository: {
        id: "app",
        path: "/tmp/working",
      },
    } as never);

    expect(guidance).toContain('id="openspec-scope"');
    expect(guidance).toContain("frontmatter repository identifies the Working Repository");
    expect(guidance).toContain("repository-relative paths within that repository");
    expect(guidance).toContain("Canonical specs use repository plus flat areas");
    expect(guidance).toContain("change artifacts use paired scopes entries");
    expect(guidance).toContain("Area normally stops at the package root");
    expect(guidance).toContain("each resulting spec remains owned by one repository");
    expect(guidance).toContain("each requirement must bind its Area explicitly");
  });

  test("omits allowed-agent policy echo from prompt guidance", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      allowedAgents: ["claude", "opencode"],
      repository: {
        id: "app",
        path: "/tmp/working",
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
      },
    } as never);

    expect(guidance).toContain('<companion-policy framework="mate" priority="mandatory">');
    expect(guidance).toContain("<mandatory-rules>");
    expect(guidance).toContain('severity="critical"');
    expect(guidance).toContain("</companion-policy>");
    expect(guidance).toContain(
      '<path role="working-repository" env="MATE_REPO_PATH">/tmp/working</path>',
    );
    expect(guidance).toContain('<linked-repository id="app" />');
  });

  test("uses intent-based artifact framing, not file extensions", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
      },
    } as never);

    expect(guidance).toContain("Agent artifacts MUST go to /tmp/companion");
    expect(guidance).toContain(
      "NEVER /tmp/working, which holds product code (README, docs, source, tests)",
    );
    expect(guidance).not.toContain('id="product-code-location"');
    expect(guidance).not.toContain("*.md");
  });

  test("includes concrete path contract with env vars", () => {
    const guidance = buildCompanionGuidance({
      companionPath: "/tmp/companion",
      policy: {},
      repository: {
        id: "app",
        path: "/tmp/working",
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
      },
    } as never);

    expect(guidance).toContain("MANDATORY RULES");
    expect(guidance).toContain("NON-NEGOTIABLE");
  });
});

describe("the friction section", () => {
  const context = {
    companionPath: "/Users/acme/code/companions/acme-companion",
    repository: { id: "acme", path: "/Users/acme/code/projects/acme.worktrees/acme-feature" },
    capabilities: ["openspec", "rtk", "graphify", "tokensave"].map((name) => ({ name })),
  };

  test("has at most 80 words and names the report command with the Invocation Name", () => {
    expect(FRICTION_GUIDANCE.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(80);
    expect(FRICTION_GUIDANCE).toContain("`mate friction report");
  });

  test("follows the companion policy only while recording is on", () => {
    const on = buildCompanionGuidance(context, { friction: true });

    expect(on.indexOf(FRICTION_GUIDANCE)).toBeGreaterThan(on.indexOf("</companion-policy>"));
    expect(buildCompanionGuidance(context)).not.toContain("## Friction");
  });

  test("keeps the guidance with every capability-gated rule under Claude Code's 10,000-character cap", () => {
    const guidance = buildCompanionGuidance(context, {
      wrapperBinPath: "/Users/acme/.mate/runtime/wrappers/bin",
      friction: true,
    });

    expect(guidance).toContain("openspec-publish");
    expect(guidance).toContain("entered-worktree-git");
    expect(guidance).toContain("codebase-exploration-rules");
    expect(guidance.length).toBeLessThan(10_000);
  });
});
