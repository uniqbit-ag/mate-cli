import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UIMessageChunk } from "ai";

import type { ChatAgent, ChatTurnRequest } from "../../../lib/studio-chat/agent";
import { chatCredentialFile, createChatCredentials } from "../../../lib/studio-chat/credential";
import { createStudioAccess } from "./access";
import { companionDigest } from "./selection";
import { CHAT_LIMITS, createStudioFetch, type StudioServerDeps } from "./server";

const PORT = 4098;
const TOKEN = "t".repeat(43);
const ORIGIN = `http://localhost:${PORT}`;
const HEADERS = {
  host: `localhost:${PORT}`,
  origin: ORIGIN,
  cookie: `mate_studio_${PORT}=${TOKEN}`,
  "content-type": "application/json",
};

let root: string;
let digest: string;
let turns: ChatTurnRequest[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-chat-"));
  digest = companionDigest(root);
  turns = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Streams `chunks`, then stays open until aborted when `hold` is set. */
function fakeAgent(chunks: UIMessageChunk[], hold = false): ChatAgent {
  return {
    turn(request) {
      turns.push(request);
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          if (!hold) return controller.close();
          request.signal.addEventListener("abort", () => controller.close(), { once: true });
        },
      });
    },
  };
}

function handlerWith(chatAgent: ChatAgent, deps: Partial<StudioServerDeps> = {}) {
  return createStudioFetch(
    {
      collectStudioInventory: async () => ({
        companions: [{ path: root, health: "ready", pairings: [] }],
      }),
      launchableAgents: async () => [],
      chatAgent,
      ...deps,
    },
    {
      chat: true,
      access: createStudioAccess({
        invocation: "interactive",
        terminal: false,
        hostname: "127.0.0.1",
        port: () => PORT,
        token: TOKEN,
      }),
    },
  );
}

const question = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Which capabilities exist?" }],
};

function chat(body: unknown, signal?: AbortSignal): Request {
  return new Request(`${ORIGIN}/api/chat`, {
    method: "POST",
    headers: HEADERS,
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

describe("POST /api/chat", () => {
  test("streams one turn for a registered companion as a UI message stream", async () => {
    const handler = handlerWith(
      fakeAgent([
        { type: "start" },
        { type: "text-start", id: "a" },
        { type: "text-delta", id: "a", delta: "acme-queue" },
        { type: "text-end", id: "a" },
        { type: "finish" },
      ]),
    );
    const response = (await handler(chat({ companion: digest, messages: [question] })))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const text = await response.text();
    expect(text).toContain('"delta":"acme-queue"');
    expect(text).toContain('"type":"finish"');
    expect(text).toContain("data: [DONE]");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.companionPath).toBe(root);
    expect(turns[0]!.messages).toEqual([question] as never);
    expect(turns[0]!.model).toBeUndefined();
    await handler.close();
  });

  test("passes the chosen model and effort to the agent", async () => {
    const handler = handlerWith(fakeAgent([{ type: "finish" }]));
    const response = (await handler(
      chat({ companion: digest, messages: [question], model: "opus", effort: "low" }),
    ))!;
    expect(response.status).toBe(200);
    await response.text();
    expect(turns[0]).toMatchObject({ model: "opus", effort: "low" });
    expect(turns[0]!.harness).toBeUndefined();
    await handler.close();
  });

  test("passes an explicit Claude Code harness to the agent", async () => {
    const handler = handlerWith(fakeAgent([{ type: "finish" }]));
    const response = (await handler(
      chat({ companion: digest, messages: [question], harness: "claude-code", model: "opus" }),
    ))!;
    expect(response.status).toBe(200);
    await response.text();
    expect(turns[0]).toMatchObject({ harness: "claude-code", model: "opus" });
    await handler.close();
  });

  test("refuses an unknown or held-back harness, or another harness's model, without an agent", async () => {
    const handler = handlerWith(fakeAgent([]));
    const status = async (body: Record<string, unknown>) =>
      (await handler(chat({ companion: digest, messages: [question], ...body })))!.status;
    expect(await status({ harness: "acme" })).toBe(400);
    // OpenCode is held back until its server keeps companion plugins out.
    expect(await status({ harness: "opencode", model: "anthropic/claude-sonnet-5-5" })).toBe(400);
    expect(await status({ model: "anthropic/claude-sonnet-5-5" })).toBe(400);
    expect(turns).toEqual([]);
    await handler.close();
  });

  test("refuses an unknown companion, a bad body and an oversized conversation without an agent", async () => {
    const handler = handlerWith(fakeAgent([]));
    const status = async (body: unknown) => (await handler(chat(body)))!.status;
    expect(await status({ companion: "0123456789", messages: [question] })).toBe(400);
    expect(await status({ companion: "../etc", messages: [question] })).toBe(400);
    expect(await status("not json")).toBe(400);
    expect(await status({ companion: digest })).toBe(400);
    expect(await status({ companion: digest, messages: [{ role: "user" }] })).toBe(400);
    const answer = { id: "a1", role: "assistant", parts: [{ type: "text", text: "acme" }] };
    expect(await status({ companion: digest, messages: [question], model: "gpt" })).toBe(400);
    expect(await status({ companion: digest, messages: [question], effort: "max" })).toBe(400);
    expect(await status({ companion: digest, messages: [question, answer] })).toBe(400);
    expect(
      await status({
        companion: digest,
        messages: Array.from({ length: CHAT_LIMITS.messages + 1 }, (_, i) => ({
          ...question,
          id: `u${i}`,
        })),
      }),
    ).toBe(413);
    const big = "x".repeat(CHAT_LIMITS.bodyBytes);
    expect(
      await status({
        companion: digest,
        messages: [{ ...question, parts: [{ type: "text", text: big }] }],
      }),
    ).toBe(413);
    expect(turns).toEqual([]);
    await handler.close();
  });

  test("runs at most two turns; a third is refused with 429 and starts nothing", async () => {
    const handler = handlerWith(fakeAgent([{ type: "start" }], true));
    const open = [new AbortController(), new AbortController()];
    const first = (await handler(
      chat({ companion: digest, messages: [question] }, open[0]!.signal),
    ))!;
    const second = (await handler(
      chat({ companion: digest, messages: [question] }, open[1]!.signal),
    ))!;
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = (await handler(chat({ companion: digest, messages: [question] })))!;
    expect(third.status).toBe(429);
    // Refused before its body is read, so a malformed one is not even noticed.
    expect((await handler(chat("{not json")))!.status).toBe(429);
    expect(turns).toHaveLength(2);
    await handler.close();
    // A closed Studio says so instead of asking to retry.
    const late = (await handler(chat({ companion: digest, messages: [question] })))!;
    expect(late.status).toBe(503);
    expect(turns).toHaveLength(2);
  });

  test("an agent that fails to start answers with its reason and frees its place", async () => {
    let calls = 0;
    const handler = handlerWith({
      turn() {
        calls += 1;
        throw new Error("acme bridge missing");
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt must find a free place.
      const response = (await handler(chat({ companion: digest, messages: [question] })))!;
      expect(response.status).toBe(500);
      // oxlint-disable-next-line no-await-in-loop
      expect(((await response.json()) as { reason: string }).reason).toContain(
        "acme bridge missing",
      );
    }
    expect(calls).toBe(3);
    await handler.close();
  });

  test("closing the request aborts the turn", async () => {
    const handler = handlerWith(fakeAgent([{ type: "start" }], true));
    const client = new AbortController();
    const response = (await handler(
      chat({ companion: digest, messages: [question] }, client.signal),
    ))!;
    expect(response.status).toBe(200);
    client.abort();
    expect(turns[0]!.signal.aborted).toBe(true);
    await response.body?.cancel().catch(() => {});
    await handler.close();
  });

  test("stopping Studio ends every running turn", async () => {
    const handler = handlerWith(fakeAgent([{ type: "start" }], true));
    const response = (await handler(chat({ companion: digest, messages: [question] })))!;
    const reading = response.text();
    await handler.close();
    expect(turns[0]!.signal.aborted).toBe(true);
    expect(await reading).toContain('"type":"start"');
  });
});

describe("GET /api/chat/session", () => {
  beforeEach(async () => {
    // The companion's own MCP server, which a chat turn does not load.
    await fs.writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { "acme-db": { command: "acme-db" } } }),
    );
  });

  const { origin: _origin, "content-type": _type, ...pageHeaders } = HEADERS;
  /** A same-origin GET from Studio's page: no Origin, fetch metadata instead. */
  function session(id: string, headers: Record<string, string> = {}): Request {
    return new Request(`${ORIGIN}/api/chat/session?companion=${id}`, {
      headers: { ...pageHeaders, "sec-fetch-site": "same-origin", ...headers },
    });
  }

  test("reports the MCP servers and plugins a turn loads without starting an agent", async () => {
    const handler = handlerWith(fakeAgent([]));
    const response = (await handler(session(digest)))!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mcpServers: [], plugins: [] });
    // A matching Origin is accepted as well.
    expect((await handler(session(digest, { origin: ORIGIN })))!.status).toBe(200);
    // A browser that sends no fetch metadata.
    const bare = new Request(`${ORIGIN}/api/chat/session?companion=${digest}`, {
      headers: pageHeaders,
    });
    expect((await handler(bare))!.status).toBe(200);
    expect(turns).toEqual([]);
    await handler.close();
  });

  test("refuses an unknown companion, a foreign page and a missing token", async () => {
    const handler = handlerWith(fakeAgent([]));
    expect((await handler(session("0123456789")))!.status).toBe(400);
    expect((await handler(session(digest, { origin: "http://acme.test" })))!.status).toBe(403);
    expect((await handler(session(digest, { "sec-fetch-site": "cross-site" })))!.status).toBe(403);
    expect((await handler(session(digest, { cookie: "" })))!.status).toBe(401);
    expect(turns).toEqual([]);
    await handler.close();
  });

  test("is refused when Studio does not offer the chat", async () => {
    const handler = createStudioFetch(
      {
        collectStudioInventory: async () => ({
          companions: [{ path: root, health: "ready", pairings: [] }],
        }),
        launchableAgents: async () => [],
      },
      {
        chat: false,
        access: createStudioAccess({
          invocation: "interactive",
          terminal: false,
          hostname: "127.0.0.1",
          port: () => PORT,
          token: TOKEN,
        }),
      },
    );
    expect((await handler(session(digest)))!.status).toBe(404);
    await handler.close();
  });
});

const KEY = "sk-ant-api03-acme";

describe("/api/chat/credential", () => {
  const credentials = () =>
    createChatCredentials({ file: chatCredentialFile(root), env: {}, appliance: false });
  function credential(method: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Request(`${ORIGIN}/api/chat/credential`, {
      method,
      headers: { ...HEADERS, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  test("answers the source, kind and date, never the value", async () => {
    const handler = handlerWith(fakeAgent([]), { chatCredentials: credentials() });
    expect(await (await handler(credential("GET")))!.json()).toEqual({
      kind: null,
      source: "login",
      setAt: null,
    });
    const set = (await handler(credential("PUT", { kind: "api-key", value: KEY })))!;
    const text = await set.text();
    expect(set.status).toBe(200);
    expect(text).not.toContain("sk-ant");
    expect(JSON.parse(text)).toMatchObject({ kind: "api-key", source: "studio" });
    expect(JSON.parse(text).setAt).toEqual(expect.any(String));
    const status = await (await handler(credential("GET")))!.text();
    expect(status).not.toContain("sk-ant");
    const cleared = (await handler(credential("DELETE")))!;
    expect(await cleared.json()).toMatchObject({ source: "login" });
    await handler.close();
  });

  test.each([
    ["subscription", KEY],
    ["api-key", "sk-ant-api03 acme"],
    ["password", KEY],
  ])("refuses kind %s with %j without quoting it, storing nothing", async (kind, value) => {
    const handler = handlerWith(fakeAgent([]), { chatCredentials: credentials() });
    const response = (await handler(credential("PUT", { kind, value })))!;
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(value);
    expect(await (await handler(credential("GET")))!.json()).toMatchObject({ source: "login" });
    await handler.close();
  });

  test("refuses a missing token and a foreign page", async () => {
    const handler = handlerWith(fakeAgent([]), { chatCredentials: credentials() });
    const body = { kind: "api-key", value: KEY };
    expect((await handler(credential("PUT", body, { cookie: "" })))!.status).toBe(401);
    expect((await handler(credential("PUT", body, { origin: "http://acme.test" })))!.status).toBe(
      403,
    );
    expect(await (await handler(credential("GET")))!.json()).toMatchObject({ source: "login" });
    await handler.close();
  });

  test("is not served where chat is not offered", async () => {
    const handler = createStudioFetch(
      {
        collectStudioInventory: async () => ({ companions: [] }),
        launchableAgents: async () => [],
      },
      {
        chat: false,
        access: createStudioAccess({
          invocation: "interactive",
          terminal: false,
          hostname: "127.0.0.1",
          port: () => PORT,
          token: TOKEN,
        }),
      },
    );
    expect((await handler(credential("GET")))!.status).toBe(404);
    await handler.close();
  });
});

describe("chat in the appliance", () => {
  const PUBLIC = "https://studio.acme.test";

  /** The appliance's Studio: served on every interface behind a proxy origin. */
  function appliance(deps: Partial<StudioServerDeps> = {}) {
    const access = createStudioAccess({
      invocation: "serve",
      terminal: false,
      hostname: "0.0.0.0",
      port: () => 4180,
      publicOrigin: PUBLIC,
      token: TOKEN,
    });
    const handler = createStudioFetch(
      {
        collectStudioInventory: async () => ({
          companions: [{ path: root, health: "ready", pairings: [] }],
        }),
        launchableAgents: async () => [],
        chatAgent: fakeAgent([{ type: "finish" }]),
        ...deps,
      },
      // What `startStudioServer` passes for a bind that is not localhost alone.
      { chat: false, access, publicOrigin: PUBLIC, profile: "appliance" },
    );
    const post = (headers: Record<string, string>) =>
      handler(
        new Request(`${PUBLIC}/api/chat`, {
          method: "POST",
          headers: {
            host: "studio.acme.test",
            origin: PUBLIC,
            cookie: `${access.cookieName()}=${TOKEN}`,
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ companion: digest, messages: [question] }),
        }),
      );
    const credential = (method: string, body?: unknown) =>
      handler(
        new Request(`${PUBLIC}/api/chat/credential`, {
          method,
          headers: {
            host: "studio.acme.test",
            origin: PUBLIC,
            cookie: `${access.cookieName()}=${TOKEN}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    return { handler, post, credential };
  }

  test("offers chat while Engineering stays disabled, and streams a turn", async () => {
    const { handler, post } = appliance();
    expect(handler.services.modePolicy).toMatchObject({ chat: true, enabled: ["analysis"] });
    const response = (await post({}))!;
    expect(response.status).toBe(200);
    await response.text();
    expect(turns).toHaveLength(1);
    await handler.close();
  });

  test("sets the chat credential; with none, no source answers", async () => {
    const chatCredentials = createChatCredentials({
      file: chatCredentialFile(root),
      env: {},
      appliance: true,
    });
    const { handler, credential } = appliance({ chatCredentials });
    expect(await (await credential("GET"))!.json()).toEqual({
      kind: null,
      source: null,
      setAt: null,
    });
    const set = (await credential("PUT", { kind: "api-key", value: KEY }))!;
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ kind: "api-key", source: "studio" });
    await handler.close();
  });

  test("refuses a subscription token without quoting it", async () => {
    const chatCredentials = createChatCredentials({
      file: chatCredentialFile(root),
      env: {},
      appliance: true,
    });
    const { handler, credential } = appliance({ chatCredentials });
    const value = "sk-ant-oat01-acme-chat";
    const refused = (await credential("PUT", { kind: "subscription", value }))!;
    expect(refused.status).toBe(400);
    const body = await refused.text();
    expect(body).toContain("API key only");
    expect(body).not.toContain(value);
    expect(chatCredentials.status()).toEqual({ kind: null, source: null, setAt: null });
    await handler.close();
  });

  test("still needs the token and Studio's own page", async () => {
    const { handler, post } = appliance();
    expect((await post({ cookie: "" }))!.status).toBe(401);
    expect((await post({ origin: "https://acme.test" }))!.status).toBe(403);
    expect(turns).toEqual([]);
    await handler.close();
  });
});
