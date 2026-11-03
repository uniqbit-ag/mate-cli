import { describe, expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { brokerHandler, handleRequest, takeAgentCredential } from "./broker";
import { CREDENTIAL_FILE, CredentialStore } from "./credential-store";
import type { WorksetRuntime } from "./runtime";

/** A runtime that records what reached it, so a refused request can be seen to stop at the broker. */
function recordingRuntime() {
  const received: Array<[string, unknown]> = [];
  const runtime = {
    spawn: async (request: unknown) => (received.push(["spawn", request]), { id: "acme-login" }),
    pause: async (id: unknown) => void received.push(["pause", id]),
    resume: async (id: unknown) => void received.push(["resume", id]),
    delete: async (id: unknown, options: unknown) =>
      void received.push(["delete", { id, options }]),
    list: async () => (received.push(["list", null]), []),
    exec: async (request: unknown) => (
      received.push(["exec", request]),
      { status: 0, stdout: "", stderr: "" }
    ),
    address: async (id: unknown) => (received.push(["address", id]), "172.18.0.5"),
  } as unknown as WorksetRuntime;
  return { runtime, received };
}

const credential = { name: "CLAUDE_CODE_OAUTH_TOKEN" as const, value: "acme-token" };
const fixed = new CredentialStore(null, credential);
const none = new CredentialStore(null, null);

async function call(handler: ReturnType<typeof brokerHandler>, operation: string, body: unknown) {
  const response = await handleRequest(
    handler,
    new Request(`http://factory/v1/${operation}`, { method: "POST", body: JSON.stringify(body) }),
  );
  return {
    status: response.status,
    text: await response.clone().text(),
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe("the broker refuses anything but Workset operations", () => {
  test.each([
    [
      "spawn",
      {
        id: "acme-login",
        repository: "acme/app",
        remoteUrl: "x",
        companion: "/companions/acme",
        volumes: ["/:/host"],
      },
    ],
    [
      "spawn",
      {
        id: "acme-login",
        repository: "acme/app",
        remoteUrl: "x",
        companion: "/c",
        privileged: true,
      },
    ],
    [
      "spawn",
      {
        id: "acme-login",
        repository: "acme/app",
        remoteUrl: "x",
        companion: "/c",
        image: "alpine",
      },
    ],
    ["exec", { id: "acme-login", command: ["sh"], user: "root" }],
    ["list", { all: true }],
  ])("%s with an extra field is refused before the runtime", async (operation, body) => {
    const { runtime, received } = recordingRuntime();
    const answer = await call(brokerHandler(runtime, fixed), operation, body);
    expect(answer.status).toBe(400);
    expect(String(answer.json.error)).toContain("does not accept");
    expect(received).toEqual([]);
  });

  test("a spawn may name its memory size", async () => {
    const { runtime, received } = recordingRuntime();
    const request = {
      id: "acme-login",
      repository: "acme/app",
      remoteUrl: "x",
      companion: "/companions/acme",
      size: "agent",
    };
    expect((await call(brokerHandler(runtime, none), "spawn", request)).status).toBe(200);
    expect(received).toEqual([["spawn", request]]);
  });

  test("an unknown operation is refused", async () => {
    const { runtime } = recordingRuntime();
    expect((await call(brokerHandler(runtime, fixed), "run", {})).status).toBe(400);
  });

  test("only POST /v1/<operation> is served", async () => {
    const { runtime } = recordingRuntime();
    const response = await handleRequest(
      brokerHandler(runtime, fixed),
      new Request("http://factory/containers/json"),
    );
    expect(response.status).toBe(404);
  });
});

describe("the agent credential", () => {
  test("is added only to an agent exec, and never echoed", async () => {
    const { runtime, received } = recordingRuntime();
    const handler = brokerHandler(runtime, fixed);
    await call(handler, "exec", { id: "acme-login", command: ["claude"], agent: true });
    await call(handler, "exec", { id: "acme-login", command: ["env"] });
    expect((received[0]![1] as { env: Record<string, string> }).env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "acme-token",
    });
    expect((received[1]![1] as { env: Record<string, string> }).env).toEqual({});
  });

  test("cannot be set by a caller", async () => {
    const { runtime, received } = recordingRuntime();
    const answer = await call(brokerHandler(runtime, fixed), "exec", {
      id: "acme-login",
      command: ["claude"],
      env: { ANTHROPIC_API_KEY: "acme-key" },
    });
    expect(answer.status).toBe(400);
    expect(received).toEqual([]);
  });

  test("a missing credential is named when an agent is requested", async () => {
    const { runtime } = recordingRuntime();
    const answer = await call(brokerHandler(runtime, none), "exec", {
      id: "acme-login",
      command: ["claude"],
      agent: true,
    });
    expect(String(answer.json.error)).toContain("Agents panel");
  });

  test("an unexpected failure is reported without its message", async () => {
    const runtime = {
      exec: async () => {
        throw new Error("boom acme-token");
      },
    } as unknown as WorksetRuntime;
    const answer = await call(brokerHandler(runtime, fixed), "exec", {
      id: "acme-login",
      command: ["claude"],
      agent: true,
    });
    expect(answer.status).toBe(500);
    expect(answer.text).not.toContain("acme-token");
  });

  test("is taken out of the environment so no child inherits it", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "acme-key", PATH: "/usr/bin" };
    expect(takeAgentCredential(env)).toEqual({ name: "ANTHROPIC_API_KEY", value: "acme-key" });
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(takeAgentCredential({})).toBeNull();
  });
});

describe("broker info", () => {
  test("names the credential's kind, never its value", async () => {
    const { runtime } = recordingRuntime();
    const answer = await call(brokerHandler(runtime, fixed), "info", {});
    expect(answer.json).toEqual({ ok: true, result: { credential: "subscription" } });
    expect(answer.text).not.toContain("acme-token");
    const empty = await call(brokerHandler(runtime, none), "info", {});
    expect(empty.json).toEqual({ ok: true, result: { credential: null } });
  });
});

describe("broker exec stdin and address", () => {
  test("stdin travels as base64 and reaches the runtime as bytes", async () => {
    const { runtime, received } = recordingRuntime();
    await call(brokerHandler(runtime, none), "exec", {
      id: "acme-login",
      command: ["tee", "a.txt"],
      stdin: Buffer.from("acme body").toString("base64"),
    });
    const request = received[0]![1] as { stdin: Uint8Array };
    expect(new TextDecoder().decode(request.stdin)).toBe("acme body");
  });

  test("address names the container's inner-network IP", async () => {
    const { runtime } = recordingRuntime();
    const answer = await call(brokerHandler(runtime, none), "address", { id: "acme-login" });
    expect(answer.json).toEqual({ ok: true, result: { address: "172.18.0.5" } });
  });
});

describe("the credential operations", () => {
  const TOKEN = "sk-ant-oat01-acme-studio";
  const KEY = "sk-ant-api03-acme-studio";
  let dir: string;

  function stored(startup = credential) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-broker-credential-"));
    return new CredentialStore(path.join(dir, CREDENTIAL_FILE), startup);
  }

  test("a replaced credential is used by the next exec, and beats the startup one", async () => {
    const { runtime, received } = recordingRuntime();
    const handler = brokerHandler(runtime, stored());
    const exec = { id: "acme-login", command: ["claude"], agent: true };
    await call(handler, "exec", exec);
    expect((await call(handler, "credential.set", { kind: "api-key", value: KEY })).status).toBe(
      200,
    );
    await call(handler, "exec", exec);
    expect(received.map(([, request]) => (request as { env: object }).env)).toEqual([
      { CLAUDE_CODE_OAUTH_TOKEN: "acme-token" },
      { ANTHROPIC_API_KEY: KEY },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("status, set and clear never answer with a value", async () => {
    const { runtime } = recordingRuntime();
    const handler = brokerHandler(runtime, stored());
    const texts: string[] = [];
    for (const [operation, body] of [
      ["credential.status", {}],
      ["credential.set", { kind: "subscription", value: TOKEN }],
      ["credential.status", {}],
      ["info", {}],
      ["credential.clear", {}],
      ["credential.status", {}],
    ] as const) {
      const answer = await call(handler, operation, body);
      expect(answer.status).toBe(200);
      texts.push(answer.text);
    }
    expect(JSON.parse(texts[2]!).result).toMatchObject({ kind: "subscription", source: "studio" });
    expect(JSON.parse(texts[5]!).result).toEqual({
      kind: "subscription",
      source: "startup",
      setAt: null,
    });
    for (const text of texts) {
      expect(text).not.toContain("acme-studio");
      expect(text).not.toContain("acme-token");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    ["credential.set", { kind: "api-key", value: KEY, name: "ANTHROPIC_API_KEY" }],
    ["credential.status", { all: true }],
    ["credential.clear", { file: "/etc/passwd" }],
  ])("%s with an extra field is refused and changes nothing", async (operation, body) => {
    const { runtime } = recordingRuntime();
    const store = stored();
    const answer = await call(brokerHandler(runtime, store), operation, body);
    expect(answer.status).toBe(400);
    expect(String(answer.json.error)).toContain("does not accept");
    expect(store.status().source).toBe("startup");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a malformed value is refused naming the kind, keeping the earlier credential", async () => {
    const { runtime } = recordingRuntime();
    const store = stored();
    const answer = await call(brokerHandler(runtime, store), "credential.set", {
      kind: "api-key",
      value: TOKEN,
    });
    expect(answer.status).toBe(400);
    expect(String(answer.json.error)).toContain("Anthropic API keys");
    expect(answer.text).not.toContain("acme-studio");
    expect(store.current()).toEqual(credential);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
