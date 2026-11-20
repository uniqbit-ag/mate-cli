import { describe, expect, test } from "bun:test";
import type { UIMessage, UIMessageChunk } from "ai";

import { CHAT_CREDENTIAL_REJECTED, type ChatHarness } from "./agent";
import { type ChatAuth, NO_CHAT_CREDENTIAL } from "./credential";
import {
  CHAT_INSTRUCTIONS,
  chatFailure,
  createHarnessChatAgent,
  type HarnessModules,
} from "./harness-chat-agent";
import type { HostSandbox, HostSandboxOptions } from "./host-sandbox";

const question: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Which capabilities exist?" }] },
];

interface Recorded {
  settings: (Parameters<HarnessModules["createAgent"]>[0] & { harness: ChatHarness })[];
  prompts: string[];
  stopped: string[];
  loads: ChatHarness[];
  sandboxes: HostSandboxOptions[];
}

/** A fake harness per harness; `gate` holds the Claude Code session's start (its install). */
function fakes(
  chunks: UIMessageChunk[] | Error,
  gate?: Promise<void>,
  credential?: () => ChatAuth,
) {
  const recorded: Recorded = { settings: [], prompts: [], stopped: [], loads: [], sandboxes: [] };
  const sandbox = {
    port: 54321,
    home: "/tmp/acme-home",
    stop: async () => void recorded.stopped.push("sandbox"),
  } as unknown as HostSandbox;
  const agent = createHarnessChatAgent({
    loadHarness: async (harness) => {
      recorded.loads.push(harness);
      return {
        createAgent: (settings) => {
          recorded.settings.push({ harness, ...settings });
          return {
            createSession: async () => {
              if (harness === "claude-code") await gate;
              return { stop: async () => void recorded.stopped.push("session") };
            },
            stream: async ({ prompt }) => {
              recorded.prompts.push(prompt);
              if (chunks instanceof Error) throw chunks;
              return {
                async *toUIMessageStream() {
                  yield* chunks;
                },
              };
            },
          };
        },
      };
    },
    createSandbox: async (sandboxOptions) => {
      recorded.sandboxes.push(sandboxOptions);
      return sandbox;
    },
    companionContext: async () => ({ instructions: "# Acme companion", skills: [] }),
    ...(credential ? { credential } : {}),
  });
  return { agent, recorded };
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<UIMessageChunk>) chunks.push(chunk);
  return chunks;
}

describe("createHarnessChatAgent", () => {
  test("streams the harness's UI chunks and stops session and sandbox after", async () => {
    const streamed: UIMessageChunk[] = [
      { type: "start" },
      {
        type: "tool-input-available",
        toolCallId: "t1",
        toolName: "glob",
        input: { pattern: "openspec/specs/*/spec.md" },
      },
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "acme-queue" },
      { type: "text-end", id: "a" },
      { type: "finish" },
    ];
    const { agent, recorded } = fakes(streamed);
    const chunks = await drain(
      agent.turn({
        companionPath: "/companions/acme",
        messages: question,
        signal: new AbortController().signal,
      }),
    );
    expect(chunks).toEqual(streamed);
    expect(recorded.prompts).toEqual(["Which capabilities exist?"]);
    expect(recorded.settings[0]).toMatchObject({ port: 54321, skills: [] });
    expect(recorded.settings[0]!.instructions).toBe(`# Acme companion\n\n${CHAT_INSTRUCTIONS}`);
    expect(recorded.stopped).toEqual(["session", "sandbox"]);
  });

  test("runs on the chosen model and effort; a model that takes no effort gets none", async () => {
    const { agent, recorded } = fakes([{ type: "finish" }]);
    const signal = new AbortController().signal;
    const request = { companionPath: "/companions/acme", messages: question, signal };
    await drain(agent.turn({ ...request, model: "opus", effort: "high" }));
    await drain(agent.turn({ ...request, model: "haiku", effort: "high" }));
    await drain(agent.turn(request));
    expect(recorded.settings[0]).toMatchObject({ model: "opus", effort: "high" });
    expect(recorded.settings[1]).toMatchObject({ model: "haiku" });
    expect(recorded.settings[1]).not.toHaveProperty("effort");
    expect(recorded.settings[2]).not.toHaveProperty("model");
    expect(recorded.settings.map(({ harness }) => harness)).toEqual(Array(3).fill("claude-code"));
  });

  test("starts its sandbox on the prebuilt bridges MATE_STUDIO_CHAT_BRIDGES names", async () => {
    const request = {
      companionPath: "/companions/acme",
      messages: question,
      signal: new AbortController().signal,
    };
    const before = process.env.MATE_STUDIO_CHAT_BRIDGES;
    try {
      delete process.env.MATE_STUDIO_CHAT_BRIDGES;
      const local = fakes([{ type: "finish" }]);
      await drain(local.agent.turn(request));
      expect(local.recorded.sandboxes[0]).not.toHaveProperty("prebuiltBridges");
      process.env.MATE_STUDIO_CHAT_BRIDGES = "/opt/acme/chat-bridges";
      const appliance = fakes([{ type: "finish" }]);
      await drain(appliance.agent.turn(request));
      expect(appliance.recorded.sandboxes[0]).toMatchObject({
        workDir: "/companions/acme",
        prebuiltBridges: "/opt/acme/chat-bridges",
      });
    } finally {
      if (before === undefined) delete process.env.MATE_STUDIO_CHAT_BRIDGES;
      else process.env.MATE_STUDIO_CHAT_BRIDGES = before;
    }
  });

  test("runs an OpenCode turn on its model with effort", async () => {
    const { agent, recorded } = fakes([{ type: "finish" }]);
    await drain(
      agent.turn({
        companionPath: "/companions/acme",
        messages: question,
        signal: new AbortController().signal,
        harness: "opencode",
        model: "openai/gpt-6.1-sol",
        effort: "low",
      }),
    );
    expect(recorded.settings).toEqual([
      expect.objectContaining({ harness: "opencode", model: "openai/gpt-6.1-sol", effort: "low" }),
    ]);
  });

  test("loads each harness once across turns", async () => {
    const { agent, recorded } = fakes([{ type: "finish" }]);
    const signal = new AbortController().signal;
    const request = { companionPath: "/companions/acme", messages: question, signal };
    await drain(agent.turn(request));
    await drain(agent.turn(request));
    await drain(agent.turn({ ...request, harness: "opencode" }));
    await drain(agent.turn({ ...request, harness: "opencode" }));
    expect(recorded.loads).toEqual(["claude-code", "opencode"]);
  });

  test("one harness's install does not hold the other's turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { agent, recorded } = fakes([{ type: "finish" }], gate);
    const signal = new AbortController().signal;
    const request = { companionPath: "/companions/acme", messages: question, signal };
    const claude = drain(agent.turn(request));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Claude Code's first session is still installing; OpenCode's turn runs regardless.
    await drain(agent.turn({ ...request, harness: "opencode" }));
    expect(recorded.prompts).toEqual(["Which capabilities exist?"]);
    release();
    await claude;
    expect(recorded.prompts).toHaveLength(2);
  });

  test("turns started together wait for the first one's install", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { agent, recorded } = fakes([{ type: "finish" }], gate);
    const signal = new AbortController().signal;
    const turns = [1, 2].map(() =>
      drain(agent.turn({ companionPath: "/companions/acme", messages: question, signal })),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Only the first turn has started a session; the second waits for its install.
    expect(recorded.settings).toHaveLength(1);
    release();
    await Promise.all(turns);
    expect(recorded.settings).toHaveLength(2);
  });

  test("a turn waiting for another's install ends as soon as it is aborted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { agent, recorded } = fakes([{ type: "finish" }], gate);
    const first = drain(
      agent.turn({
        companionPath: "/companions/acme",
        messages: question,
        signal: new AbortController().signal,
      }),
    );
    const controller = new AbortController();
    const second = drain(
      agent.turn({
        companionPath: "/companions/acme",
        messages: question,
        signal: controller.signal,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await second).toEqual([]);
    expect(recorded.settings).toHaveLength(1);
    release();
    await first;
  });

  describe("the chat credential", () => {
    const KEY = { name: "ANTHROPIC_API_KEY", value: "sk-ant-api03-acme" } as const;
    const ask = (agent: ReturnType<typeof fakes>["agent"]) =>
      drain(
        agent.turn({
          companionPath: "/companions/acme",
          messages: question,
          signal: new AbortController().signal,
        }),
      );

    test("a set credential reaches the harness, read at each turn", async () => {
      let auth: ChatAuth = KEY;
      const { agent, recorded } = fakes([{ type: "finish" }], undefined, () => auth);
      await ask(agent);
      auth = "login";
      await ask(agent);
      expect(recorded.settings[0]!.credential).toEqual(KEY);
      // Nothing set on a standard Studio: the harness resolves the login, as before.
      expect(recorded.settings[1]).not.toHaveProperty("credential");
    });

    test("none fails the turn before loading, sandboxing or installing anything", async () => {
      const { agent, recorded } = fakes([{ type: "finish" }], undefined, () => null);
      expect(await ask(agent)).toEqual([{ type: "error", errorText: NO_CHAT_CREDENTIAL }]);
      expect(recorded.loads).toEqual([]);
      expect(recorded.sandboxes).toEqual([]);
      expect(recorded.settings).toEqual([]);
    });

    test("a rejected credential names its kind, never its value", async () => {
      const { agent } = fakes(
        new Error("Invalid API key · Fix external API key"),
        undefined,
        () => KEY,
      );
      const [chunk] = await ask(agent);
      const text = (chunk as { errorText: string }).errorText;
      expect(text).toStartWith(CHAT_CREDENTIAL_REJECTED);
      expect(text).toContain("Anthropic API key");
      expect(text).not.toContain(KEY.value);
    });
  });

  test("reports a missing login as a readable error and cleans up", async () => {
    const { agent, recorded } = fakes(new Error("Not logged in · Please run /login"));
    const chunks = await drain(
      agent.turn({
        companionPath: "/companions/acme",
        messages: question,
        signal: new AbortController().signal,
      }),
    );
    expect(chunks).toEqual([
      { type: "error", errorText: expect.stringContaining("no local login") },
    ]);
    expect(recorded.stopped).toEqual(["session", "sandbox"]);
  });

  test("names OpenCode's missing credential and what to provide", async () => {
    const { agent } = fakes(
      new Error(
        "AI_LoadAPIKeyError: Anthropic API key is missing. Pass it using the 'apiKey' parameter.",
      ),
    );
    const chunks = await drain(
      agent.turn({
        companionPath: "/companions/acme",
        messages: question,
        signal: new AbortController().signal,
        harness: "opencode",
        model: "anthropic/claude-sonnet-5-5",
      }),
    );
    expect(chunks).toEqual([
      {
        type: "error",
        errorText:
          "OpenCode has no credential for anthropic. Set ANTHROPIC_API_KEY in Studio's environment, then ask again.",
      },
    ]);
  });

  test("refuses a conversation without a question before starting anything", async () => {
    const { agent, recorded } = fakes([{ type: "finish" }]);
    const chunks = await drain(
      agent.turn({
        companionPath: "/companions/acme",
        messages: [],
        signal: new AbortController().signal,
      }),
    );
    expect(chunks).toEqual([
      { type: "error", errorText: "Claude Code: the conversation must end with a question" },
    ]);
    expect(recorded.loads).toEqual([]);
    expect(recorded.stopped).toEqual([]);
  });

  test("an aborted turn ends quietly and stops what it started", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { agent, recorded } = fakes([{ type: "finish" }], gate);
    const controller = new AbortController();
    const stream = agent.turn({
      companionPath: "/companions/acme",
      messages: question,
      signal: controller.signal,
    });
    const drained = drain(stream);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    release();
    // The fake does not watch the signal, so the turn still finishes; nothing reports an error.
    expect((await drained).some((chunk) => chunk.type === "error")).toBe(false);
    expect(recorded.stopped).toEqual(["session", "sandbox"]);
  });
});

test("chatFailure keeps other reasons, naming the harness", () => {
  expect(chatFailure(new Error("the bridge did not start"))).toBe(
    "Claude Code: the bridge did not start",
  );
  expect(chatFailure("rate limited", "opencode")).toBe("OpenCode: rate limited");
  expect(
    chatFailure({ name: "UnknownError", data: { message: "Model not found: acme/x" } }, "opencode"),
  ).toBe("OpenCode: Model not found: acme/x");
});

test("chatFailure blames the credential only for Anthropic's own refusal", () => {
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-api03-acme" } as const;
  expect(
    chatFailure(new Error("Proxy authentication required"), "claude-code", undefined, key),
  ).toBe("Claude Code: Proxy authentication required");
  expect(chatFailure(new Error("mcp.acme.test answered 401"), "claude-code", undefined, key)).toBe(
    "Claude Code: mcp.acme.test answered 401",
  );
  expect(
    chatFailure(
      new Error('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'),
      "claude-code",
      undefined,
      key,
    ),
  ).toStartWith(CHAT_CREDENTIAL_REJECTED);
});

test("chatFailure points OpenCode at the provider's key or its login", () => {
  expect(chatFailure(new Error("401 Unauthorized"), "opencode", "openai/gpt-6.1-sol")).toBe(
    "OpenCode has no credential for openai. Set OPENAI_API_KEY in Studio's environment, or log in with `opencode auth login`, then ask again.",
  );
  // A Claude login is Claude Code's, never OpenCode's.
  expect(chatFailure(new Error("Not logged in"), "opencode")).toBe("OpenCode: Not logged in");
});
