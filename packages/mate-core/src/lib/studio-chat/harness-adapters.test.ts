import { beforeEach, expect, mock, test } from "bun:test";

/** What each turn handed `HarnessAgent` and the harness factories, captured by the mocks. */
let agents: Record<string, unknown>[] = [];
let adapters: { harness: string; settings: Record<string, unknown> }[] = [];

mock.module("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(settings: Record<string, unknown>) {
      agents.push(settings);
    }
  },
}));
mock.module("@ai-sdk/harness-opencode", () => ({
  createOpenCode: (settings: Record<string, unknown>) => {
    adapters.push({ harness: "opencode", settings });
    return { id: "opencode" };
  },
}));
mock.module("@ai-sdk/harness-claude-code", () => ({
  createClaudeCode: (settings: Record<string, unknown>) => {
    adapters.push({ harness: "claude-code", settings });
    return { id: "claude-code" };
  },
}));

const { loadHarness } = await import("./harness-chat-agent");

beforeEach(() => {
  agents = [];
  adapters = [];
});

const turn = { port: 4242, instructions: "# Acme companion", skills: [] };

test("an OpenCode turn offers read tools only, with its reasoning variant and no MCP servers or credential", async () => {
  const modules = await loadHarness("opencode");
  modules.createAgent({ ...turn, model: "anthropic/claude-sonnet-5-5", effort: "high" });
  // `toEqual`, so neither `mcpServers` nor `auth` is passed.
  expect(adapters).toEqual([
    {
      harness: "opencode",
      settings: {
        port: 4242,
        // The OpenCode login it may fall back on is looked up by provider.
        provider: "anthropic",
        openCodeConfig: { share: "disabled", autoupdate: false },
        reasoningVariant: "high",
      },
    },
  ]);
  expect(agents).toEqual([
    {
      harness: { id: "opencode" },
      model: "anthropic/claude-sonnet-5-5",
      activeTools: ["read", "grep", "glob"],
      permissionMode: "allow-reads",
      skills: [],
      instructions: "# Acme companion",
      sandboxConfig: { workDir: "." },
    },
  ]);
});

test("an OpenCode turn without model or effort runs on its default model, with no reasoning variant", async () => {
  (await loadHarness("opencode")).createAgent(turn);
  expect(adapters[0]!.settings).not.toHaveProperty("reasoningVariant");
  expect(adapters[0]!.settings.provider).toBe("anthropic");
  expect(agents[0]!.model).toBe("anthropic/claude-sonnet-5-5");
});

test("an OpenCode turn names the provider of its model", async () => {
  (await loadHarness("opencode")).createAgent({ ...turn, model: "openai/gpt-6.1-sol" });
  expect(adapters[0]!.settings.provider).toBe("openai");
});

test("a Claude Code turn keeps its own tools and drops the companion's MCP servers", async () => {
  (await loadHarness("claude-code")).createAgent({ ...turn, model: "opus", effort: "low" });
  expect(adapters).toEqual([
    { harness: "claude-code", settings: { port: 4242, strictMcpConfig: true, effort: "low" } },
  ]);
  expect(agents[0]).toMatchObject({
    harness: { id: "claude-code" },
    model: "opus",
    activeTools: ["read", "grep", "glob", "Skill"],
    permissionMode: "allow-reads",
  });
});

test("a Claude Code turn with a credential hands the harness only that", async () => {
  (await loadHarness("claude-code")).createAgent({
    ...turn,
    credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-acme" },
  });
  expect(adapters).toEqual([
    {
      harness: "claude-code",
      settings: {
        port: 4242,
        strictMcpConfig: true,
        auth: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-acme" },
      },
    },
  ]);
});
