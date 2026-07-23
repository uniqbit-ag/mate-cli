import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

describe("Mate OpenCode TUI plugin", () => {
  test("keeps full home/sidebar content and adds a compact active-session footer", async () => {
    const source = await fs.readFile(path.resolve(import.meta.dirname, "./tui.tsx"), "utf8");

    expect(source).toContain("slots: {\n      home_bottom()");
    expect(source).toContain("sidebar_content()");
    expect(source).toContain("app_bottom()");
    expect(source).toContain("api.renderer.width >= NARROW_TERMINAL_WIDTH");
    expect(source).toContain('api.route.current.name !== "session"');
    expect(source).toContain("compact />");
    expect(source).toContain("sidebar />");
    expect(source).toContain("order: 0");
    expect(source).toContain("mate v{MATE_VERSION}");
    expect(source).not.toContain("managed session");
    expect(source).not.toContain("showToast");
  });

  test("is exported through the core ./opencode subpath", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"),
    ) as { exports?: Record<string, string> };

    expect(packageJson.exports?.["./opencode"]).toBe("./src/opencode/index.ts");

    const index = await fs.readFile(path.resolve(import.meta.dirname, "index.ts"), "utf8");
    expect(index).toContain('export { default as tuiPlugin } from "./tui"');
  });
});
