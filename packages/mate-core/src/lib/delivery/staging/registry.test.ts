import { describe, expect, test } from "bun:test";

import { OPENSPEC_LAYOUT } from "../../../runtime/submitted-arrivals";
import { defaultArtifactType } from "./registry";

describe("defaultArtifactType", () => {
  // The session-start sync may not import `lib/`, so it reads the layout from OPENSPEC_LAYOUT.
  test("keeps the folders and record names of OPENSPEC_LAYOUT", () => {
    const type = defaultArtifactType();
    expect([type.source, type.archiveRoot]).toEqual([
      OPENSPEC_LAYOUT.source,
      OPENSPEC_LAYOUT.archiveRoot,
    ]);
    for (const id of ["2026-11-02-acme-login", "acme-login", "2026-11-02"]) {
      const name = type.isRecordId(id) ? type.recordName(id) : null;
      expect(OPENSPEC_LAYOUT.recordName(id)).toBe(name);
    }
  });
});
