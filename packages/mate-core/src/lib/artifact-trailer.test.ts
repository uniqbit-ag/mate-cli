import { describe, expect, test } from "bun:test";

import { archiveOfArtifact, openspecArtifact, openspecSpecsArtifact } from "./artifact-trailer";

describe("artifact trailer", () => {
  test("an archive's value round-trips to its anchor", () => {
    expect(openspecArtifact("2026-11-02-acme")).toBe("openspec/2026-11-02-acme");
    expect(archiveOfArtifact(" openspec/2026-11-02-acme ")).toBe("2026-11-02-acme");
  });

  test("a spec publication names no archive", () => {
    const value = openspecSpecsArtifact("2026-09-14-widget-api");
    expect(value).toBe("openspec/specs/2026-09-14-widget-api");
    expect(archiveOfArtifact(value)).toBeNull();
  });

  test("another artifact type or a bare anchor names no archive", () => {
    expect(archiveOfArtifact("acme/2026-11-02-acme")).toBeNull();
    expect(archiveOfArtifact("2026-11-02-acme")).toBeNull();
    expect(archiveOfArtifact("")).toBeNull();
  });
});
