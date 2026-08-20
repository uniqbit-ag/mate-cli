import { describe, expect, test } from "bun:test";

import {
  InvalidMateResponseError,
  parseMaterializedWorkspace,
  parseSessionEnvelopeResolution,
  parseWorkspaceInventory,
  UnsupportedSchemaVersionError,
} from "./schema";

describe("parseWorkspaceInventory", () => {
  test("accepts a well-formed schema-version-1 response", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      companions: [{ path: "/companions/a", health: "ready" }],
      pairings: [
        {
          companionPath: "/companions/a",
          repository: { id: "app", path: "/repos/app" },
          health: "ready",
          ambiguous: false,
        },
      ],
    });

    const inventory = parseWorkspaceInventory(raw);

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.companions).toHaveLength(1);
    expect(inventory.pairings).toHaveLength(1);
  });

  test("preserves a diagnostic when present", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      companions: [{ path: "/companions/a", health: "unreadable", diagnostic: "bad yaml" }],
      pairings: [],
    });

    const inventory = parseWorkspaceInventory(raw);

    expect(inventory.companions[0]?.diagnostic).toBe("bad yaml");
  });

  test("rejects malformed JSON", () => {
    expect(() => parseWorkspaceInventory("not json")).toThrow(InvalidMateResponseError);
  });

  test("rejects an unsupported schema version", () => {
    const raw = JSON.stringify({ schemaVersion: 2, companions: [], pairings: [] });

    expect(() => parseWorkspaceInventory(raw)).toThrow(UnsupportedSchemaVersionError);
  });

  test("rejects a response missing the companions array", () => {
    const raw = JSON.stringify({ schemaVersion: 1, pairings: [] });

    expect(() => parseWorkspaceInventory(raw)).toThrow(InvalidMateResponseError);
  });

  test("rejects a companion entry with an unknown health value", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      companions: [{ path: "/companions/a", health: "totally-broken" }],
      pairings: [],
    });

    expect(() => parseWorkspaceInventory(raw)).toThrow(InvalidMateResponseError);
  });

  test("rejects a pairing entry missing its ambiguous flag", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      companions: [],
      pairings: [
        {
          companionPath: "/companions/a",
          repository: { id: "app", path: "/repos/app" },
          health: "ready",
        },
      ],
    });

    expect(() => parseWorkspaceInventory(raw)).toThrow(InvalidMateResponseError);
  });
});

describe("parseMaterializedWorkspace", () => {
  test("accepts a well-formed schema-version-1 response", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      workspacePath: "/repo/.mate/workspace.code-workspace",
      folders: ["/repo", "/companion"],
    });

    const result = parseMaterializedWorkspace(raw);

    expect(result).toEqual({
      schemaVersion: 1,
      workspacePath: "/repo/.mate/workspace.code-workspace",
      folders: ["/repo", "/companion"],
    });
  });

  test("rejects an unsupported schema version", () => {
    const raw = JSON.stringify({
      schemaVersion: 99,
      workspacePath: "/repo/.mate/workspace.code-workspace",
      folders: ["/repo", "/companion"],
    });

    expect(() => parseMaterializedWorkspace(raw)).toThrow(UnsupportedSchemaVersionError);
  });

  test("rejects a response with a malformed folders pair", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      workspacePath: "/repo/.mate/workspace.code-workspace",
      folders: ["/repo"],
    });

    expect(() => parseMaterializedWorkspace(raw)).toThrow(InvalidMateResponseError);
  });
});

describe("parseSessionEnvelopeResolution", () => {
  const envelope = {
    schemaVersion: 1,
    host: "mate.chat",
    repositoryLink: {
      schemaVersion: 1,
      repository: { id: "app", path: "/repos/app" },
      companionPath: "/companions/a",
    },
    workingRepositoryPath: "/repos/app",
    companionRepositoryPath: "/companions/a",
    capabilities: [{ name: "tokensave" }],
    renderedGuidance: "guidance",
    permittedRoots: ["/repos/app", "/companions/a"],
  };

  test("accepts a resolved versioned envelope", () => {
    const result = parseSessionEnvelopeResolution(
      JSON.stringify({ schemaVersion: 1, status: "resolved", envelope, diagnostics: [] }),
    );

    expect(result.envelope?.repositoryLink.companionPath).toBe("/companions/a");
  });

  test("accepts an ambiguity diagnostic with candidates", () => {
    const result = parseSessionEnvelopeResolution(
      JSON.stringify({
        schemaVersion: 1,
        status: "diagnostic",
        diagnostics: [
          {
            code: "selection-required",
            message: "select a link",
            candidates: [envelope.repositoryLink],
          },
        ],
      }),
    );

    expect(result.diagnostics[0]?.candidates).toHaveLength(1);
  });

  test("rejects an unsupported envelope schema version", () => {
    expect(() =>
      parseSessionEnvelopeResolution(
        JSON.stringify({ schemaVersion: 2, status: "diagnostic", diagnostics: [] }),
      ),
    ).toThrow(UnsupportedSchemaVersionError);
  });
});
