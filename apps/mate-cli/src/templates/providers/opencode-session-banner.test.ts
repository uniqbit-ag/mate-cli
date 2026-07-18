import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

describe("OpenCode Mate companion TUI plugin", () => {
  test("keeps full home/sidebar content and adds a compact active-session footer", async () => {
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "./opencode/plugins/mate-companion-tui.tsx"),
      "utf8",
    );
    const config = JSON.parse(
      await fs.readFile(path.resolve(import.meta.dirname, "./opencode/tui.json"), "utf8"),
    ) as { plugin?: string[] };

    expect(config.plugin).toEqual(["./plugins/mate-companion-tui.tsx"]);
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
});
