/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioSkillInventory } from "../../mate-inventory";
import { Skills } from "./index";

function render(skills: StudioSkillInventory): string {
  return String(<Skills skills={skills} />);
}

describe("Skills", () => {
  it("lists every runtime's skills without merging them", () => {
    const markup = render({
      claude: ["claude-only", "shared-skill"],
      opencode: ["opencode-only", "shared-skill"],
      agents: ["agent-only", "shared-skill"],
    });

    expect(markup).toContain("claude-only");
    expect(markup).toContain("opencode-only");
    expect(markup).toContain("agent-only");
    expect(markup.match(/shared-skill/g)).toHaveLength(6);
  });

  it("starts on Claude and keeps an empty runtime explicit", () => {
    const markup = render({ claude: ["mate-interview-me"], opencode: [], agents: [] });

    expect(markup).toContain('data-skill-profile="claude"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('data-skill-panel="opencode"');
    expect(markup).toContain("No OpenCode skills in this companion.");
    expect(markup).toContain('data-skill-panel="agents"');
    expect(markup).toContain("No Agents skills in this companion.");
  });

  it("renders no skills when the inventory is absent", () => {
    expect(String(<Skills />)).toContain("No Claude skills in this companion.");
  });
});
