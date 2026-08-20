import { describe, expect, mock, test } from "bun:test";

import { createVscodeMock } from "./test-support/vscode-mock";

mock.module("vscode", () => createVscodeMock().module);

const { resolveNativeChatConversation } = await import("./native-chat-host");

const linkA = {
  schemaVersion: 1 as const,
  repository: { id: "app", path: "/repos/app" },
  companionPath: "/companions/a",
};
const linkB = { ...linkA, companionPath: "/companions/b" };

function resolved(link: typeof linkA) {
  return {
    schemaVersion: 1 as const,
    status: "resolved" as const,
    diagnostics: [],
    envelope: {
      schemaVersion: 1 as const,
      host: "mate.chat",
      repositoryLink: link,
      workingRepositoryPath: link.repository.path,
      companionRepositoryPath: link.companionPath,
      capabilities: [],
      renderedGuidance: "guidance",
      permittedRoots: [link.repository.path, link.companionPath],
    },
  };
}

describe("resolveNativeChatConversation", () => {
  test("pins an unambiguous active context without opening a picker", async () => {
    let picks = 0;
    const result = await resolveNativeChatConversation(
      {},
      { host: "mate.chat", workspaceRoots: ["/repos/app"] },
      {
        resolve: async () => resolved(linkA),
        pick: async () => {
          picks += 1;
          return linkA;
        },
      },
    );

    expect(result.state.pinnedRepositoryLink).toEqual(linkA);
    expect(picks).toBe(0);
  });

  test("requires an explicit picker choice when resolution is ambiguous", async () => {
    const requests: unknown[] = [];
    const result = await resolveNativeChatConversation(
      {},
      { host: "mate.chat", activePath: "/repos/app/index.ts" },
      {
        resolve: async (request) => {
          requests.push(request);
          return requests.length === 1
            ? {
                schemaVersion: 1,
                status: "diagnostic",
                diagnostics: [
                  {
                    code: "selection-required",
                    message: "select",
                    candidates: [linkA, linkB],
                  },
                ],
              }
            : resolved(linkB);
        },
        pick: async (candidates) => candidates[1],
      },
    );

    expect(result.state.pinnedRepositoryLink).toEqual(linkB);
    expect(requests[1]).toMatchObject({ companionPath: "/companions/b", repositoryId: "app" });
  });

  test("revalidates the pinned link instead of replacing it after active-editor changes", async () => {
    let request: Record<string, unknown> | undefined;
    const result = await resolveNativeChatConversation(
      { pinnedRepositoryLink: linkA },
      { host: "mate.chat", activePath: "/repos/other/index.ts" },
      {
        resolve: async (value) => {
          request = value as Record<string, unknown>;
          return resolved(linkA);
        },
        pick: async () => linkB,
      },
    );

    expect(result.state.pinnedRepositoryLink).toEqual(linkA);
    expect(request).toMatchObject({ companionPath: "/companions/a", repositoryPath: "/repos/app" });
  });

  test("recovers a stale pinned link through the current candidates", async () => {
    let calls = 0;
    const result = await resolveNativeChatConversation(
      { pinnedRepositoryLink: linkA },
      { host: "mate.chat", workspaceRoots: ["/repos/app"] },
      {
        resolve: async () => {
          calls += 1;
          return calls === 1
            ? {
                schemaVersion: 1,
                status: "diagnostic",
                diagnostics: [
                  {
                    code: "selection-not-found",
                    message: "stale",
                    candidates: [linkB],
                  },
                ],
              }
            : resolved(linkB);
        },
        pick: async () => linkB,
      },
    );

    expect(result.state.pinnedRepositoryLink).toEqual(linkB);
    expect(calls).toBe(2);
  });
});
