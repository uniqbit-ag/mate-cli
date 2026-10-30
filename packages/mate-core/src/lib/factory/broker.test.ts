import { describe, expect, test } from "bun:test";

import { brokerHandler, handleRequest, takeAgentCredential } from "./broker";
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
    const answer = await call(brokerHandler(runtime, credential), operation, body);
    expect(answer.status).toBe(400);
    expect(String(answer.json.error)).toContain("does not accept");
    expect(received).toEqual([]);
  });

  test("an unknown operation is refused", async () => {
    const { runtime } = recordingRuntime();
    expect((await call(brokerHandler(runtime, credential), "run", {})).status).toBe(400);
  });

  test("only POST /v1/<operation> is served", async () => {
    const { runtime } = recordingRuntime();
    const response = await handleRequest(
      brokerHandler(runtime, credential),
      new Request("http://factory/containers/json"),
    );
    expect(response.status).toBe(404);
  });
});

describe("the agent credential", () => {
  test("is added only to an agent exec, and never echoed", async () => {
    const { runtime, received } = recordingRuntime();
    const handler = brokerHandler(runtime, credential);
    await call(handler, "exec", { id: "acme-login", command: ["claude"], agent: true });
    await call(handler, "exec", { id: "acme-login", command: ["env"] });
    expect((received[0]![1] as { env: Record<string, string> }).env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "acme-token",
    });
    expect((received[1]![1] as { env: Record<string, string> }).env).toEqual({});
  });

  test("cannot be set by a caller", async () => {
    const { runtime, received } = recordingRuntime();
    const answer = await call(brokerHandler(runtime, credential), "exec", {
      id: "acme-login",
      command: ["claude"],
      env: { ANTHROPIC_API_KEY: "acme-key" },
    });
    expect(answer.status).toBe(400);
    expect(received).toEqual([]);
  });

  test("a missing credential is named when an agent is requested", async () => {
    const { runtime } = recordingRuntime();
    const answer = await call(brokerHandler(runtime, null), "exec", {
      id: "acme-login",
      command: ["claude"],
      agent: true,
    });
    expect(String(answer.json.error)).toContain("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY");
  });

  test("an unexpected failure is reported without its message", async () => {
    const runtime = {
      exec: async () => {
        throw new Error("boom acme-token");
      },
    } as unknown as WorksetRuntime;
    const answer = await call(brokerHandler(runtime, credential), "exec", {
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
  test("names the credential, never its value", async () => {
    const { runtime } = recordingRuntime();
    const answer = await call(brokerHandler(runtime, credential), "info", {});
    expect(answer.json).toEqual({ ok: true, result: { credential: "CLAUDE_CODE_OAUTH_TOKEN" } });
    expect(answer.text).not.toContain("acme-token");
    const none = await call(brokerHandler(runtime, null), "info", {});
    expect(none.json).toEqual({ ok: true, result: { credential: null } });
  });
});

describe("broker exec stdin and address", () => {
  test("stdin travels as base64 and reaches the runtime as bytes", async () => {
    const { runtime, received } = recordingRuntime();
    await call(brokerHandler(runtime, null), "exec", {
      id: "acme-login",
      command: ["tee", "a.txt"],
      stdin: Buffer.from("acme body").toString("base64"),
    });
    const request = received[0]![1] as { stdin: Uint8Array };
    expect(new TextDecoder().decode(request.stdin)).toBe("acme body");
  });

  test("address names the container's inner-network IP", async () => {
    const { runtime } = recordingRuntime();
    const answer = await call(brokerHandler(runtime, null), "address", { id: "acme-login" });
    expect(answer.json).toEqual({ ok: true, result: { address: "172.18.0.5" } });
  });
});
