import { describe, expect, test } from "bun:test";

import { OpenCodeAdapter } from "./adapters/opencode";
import type { FrameworkConfig } from "./types";
import {
  resolveSessionEnvelope,
  type SessionEnvelopeCandidate,
  type SessionEnvelopeDeps,
} from "./session-envelope";

const repository = { id: "app", path: "/repos/app" };
const candidateA: SessionEnvelopeCandidate = {
  schemaVersion: 1,
  repository,
  companionPath: "/companions/a",
};
const candidateB: SessionEnvelopeCandidate = {
  schemaVersion: 1,
  repository,
  companionPath: "/companions/b",
};
const config: FrameworkConfig = {
  type: "companion",
  allowedAgents: ["claude", "opencode"],
  capabilities: [{ name: "tokensave" }],
};

function makeDeps(candidates: SessionEnvelopeCandidate[]): SessionEnvelopeDeps {
  return {
    listCandidates: async () => candidates,
    readConfig: async () => config,
    isDirectory: async () => true,
    readCompanionRegistry: async () => ({ repos: [repository] }),
  };
}

describe("resolveSessionEnvelope", () => {
  test("resolves an explicit Repository Link without host side effects", async () => {
    const result = await resolveSessionEnvelope(
      {
        host: "vscode-chat",
        selection: { companionPath: candidateA.companionPath, repositoryId: "app" },
      },
      makeDeps([candidateA, candidateB]),
    );

    expect(result.status).toBe("resolved");
    expect(result.envelope).toMatchObject({
      schemaVersion: 1,
      host: "vscode-chat",
      repositoryLink: candidateA,
      workingRepositoryPath: "/repos/app",
      companionRepositoryPath: "/companions/a",
      capabilities: [{ name: "tokensave" }],
      permittedRoots: ["/repos/app", "/companions/a"],
    });
    expect(result.envelope?.renderedGuidance).toContain("companion-policy");
  });

  test("resolves exactly one candidate from workspace context", async () => {
    const result = await resolveSessionEnvelope(
      { host: "workspace-command", workspaceRoots: ["/repos/app"] },
      makeDeps([candidateA]),
    );

    expect(result.status).toBe("resolved");
    expect(result.envelope?.repositoryLink).toEqual(candidateA);
  });

  test("reports no match when workspace context has no eligible candidate", async () => {
    const result = await resolveSessionEnvelope(
      { host: "workspace-command", workspaceRoots: ["/repos/unknown"] },
      makeDeps([candidateA]),
    );

    expect(result.status).toBe("diagnostic");
    expect(result.diagnostics[0]).toMatchObject({ code: "working-repository-not-found" });
    expect(result.envelope).toBeUndefined();
  });

  test("reports every candidate when workspace context is ambiguous", async () => {
    const result = await resolveSessionEnvelope(
      { host: "vscode-chat", activePath: "/repos/app/src/index.ts" },
      makeDeps([candidateB, candidateA]),
    );

    expect(result.status).toBe("diagnostic");
    expect(result.diagnostics[0]?.code).toBe("selection-required");
    expect(result.diagnostics[0]?.candidates).toEqual([candidateA, candidateB]);
    expect(result.envelope).toBeUndefined();
  });

  test("preserves guidance, roots, adapter arguments, and launch environment", async () => {
    const result = await resolveSessionEnvelope(
      { host: "claude", workspaceRoots: ["/repos/app"] },
      makeDeps([candidateA]),
    );
    const envelope = result.envelope!;
    const context = {
      repository: envelope.repositoryLink.repository,
      allowedAgents: ["claude", "opencode"],
      companionPath: envelope.companionRepositoryPath,
      capabilities: envelope.capabilities,
    };

    const openCodeAdapter = new OpenCodeAdapter();
    const openCodeArgs = openCodeAdapter.buildArgs(context, ["--print"]);
    const openCodeEnvironment = openCodeAdapter.extendEnvironment(context);

    expect(envelope.renderedGuidance).toContain("companion-policy");
    expect(envelope.permittedRoots).toEqual(["/repos/app", "/companions/a"]);
    expect(openCodeArgs).toEqual(["/repos/app", "--print"]);
    expect(openCodeEnvironment.OPENCODE_CONFIG_DIR).toBe("/companions/a/.opencode");
    expect(openCodeEnvironment.MATE_GUIDANCE_JSON).toContain("companionGuidance");
  });
});
