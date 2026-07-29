import { describe, expect, test } from "bun:test";

import {
  PI_MCP_ADAPTER_MIN_VERSION,
  PI_MIN_VERSION,
  isSupportedVersion,
  piRuntimeDiagnostic,
} from "./pi-runtime";

describe("Pi runtime requirements", () => {
  test("accepts the supported minimum versions", () => {
    expect(isSupportedVersion(PI_MIN_VERSION, PI_MIN_VERSION)).toBe(true);
    expect(isSupportedVersion(PI_MCP_ADAPTER_MIN_VERSION, PI_MCP_ADAPTER_MIN_VERSION)).toBe(true);
    expect(
      piRuntimeDiagnostic({
        piVersion: PI_MIN_VERSION,
        mcpAdapterVersion: PI_MCP_ADAPTER_MIN_VERSION,
      }),
    ).toBeUndefined();
  });

  test("rejects a prerelease of the minimum stable version", () => {
    expect(isSupportedVersion("0.82.0-beta.1", PI_MIN_VERSION)).toBe(false);
  });

  test("reports actionable runtime diagnostics", () => {
    expect(piRuntimeDiagnostic({ piVersion: "0.81.0", mcpAdapterVersion: "2.15.0" })).toContain(
      "Pi 0.82.0 or newer",
    );
    expect(piRuntimeDiagnostic({ piVersion: "0.82.0" })).toContain(
      "pi-mcp-adapter 2.15.0 or newer",
    );
    expect(piRuntimeDiagnostic({ piVersion: "0.82.0", mcpAdapterVersion: "2.14.0" })).toContain(
      "pi install npm:pi-mcp-adapter",
    );
  });
});
