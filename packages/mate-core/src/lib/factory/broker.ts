import { FactoryError } from "./ids";
import type { WorksetRuntime } from "./runtime";

/**
 * The factory broker's API: the six Workset operations over HTTP on a Unix
 * socket, and nothing else. It is the boundary between processes running as
 * the unprivileged user and the inner Docker daemon, so every request is
 * checked field by field and an unexpected field is refused rather than
 * ignored: a caller cannot ask for a mount, an image or a privilege.
 */

export const AGENT_CREDENTIAL_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
export type AgentCredentialName = (typeof AGENT_CREDENTIAL_NAMES)[number];

export interface AgentCredential {
  name: AgentCredentialName;
  value: string;
}

/**
 * Takes the Workset agent credential out of the process environment so no
 * child — Git runs as the unprivileged user — inherits it. Held in memory and
 * added only to an `exec` that starts an agent.
 */
export function takeAgentCredential(env: NodeJS.ProcessEnv = process.env): AgentCredential | null {
  let credential: AgentCredential | null = null;
  for (const name of AGENT_CREDENTIAL_NAMES) {
    const value = env[name];
    delete env[name];
    if (value && credential === null) credential = { name, value };
  }
  return credential;
}

type Body = Record<string, unknown>;

function only(body: Body, allowed: string[]): void {
  const accepted = new Set(allowed);
  const extra = Object.keys(body).filter((key) => !accepted.has(key));
  if (extra.length > 0) {
    throw new FactoryError(
      `the broker does not accept ${extra.map((key) => `"${key}"`).join(", ")}`,
    );
  }
}

function stringRecord(value: unknown, what: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.values(value).every((entry) => typeof entry === "string")
  ) {
    throw new FactoryError(`${what} must map names to strings`);
  }
  return value as Record<string, string>;
}

export interface BrokerHandler {
  (operation: string, body: Body): Promise<unknown>;
}

export function brokerHandler(
  runtime: WorksetRuntime,
  credential: AgentCredential | null,
): BrokerHandler {
  return async (operation, body) => {
    switch (operation) {
      case "spawn":
        only(body, ["id", "repository", "remoteUrl", "companion"]);
        return runtime.spawn(body as never);
      case "pause":
        only(body, ["id"]);
        await runtime.pause(body.id as string);
        return {};
      case "resume":
        only(body, ["id"]);
        await runtime.resume(body.id as string);
        return {};
      case "delete":
        only(body, ["id", "force"]);
        if (body.force !== undefined && typeof body.force !== "boolean") {
          throw new FactoryError("force must be true or false");
        }
        await runtime.delete(body.id as string, { force: body.force === true });
        return {};
      case "list":
        only(body, []);
        return { worksets: await runtime.list() };
      case "address":
        only(body, ["id"]);
        return { address: await runtime.address(body.id as string) };
      case "info":
        only(body, []);
        // The name only: callers may know whether an agent can start, never the value.
        return { credential: credential?.name ?? null };
      case "exec": {
        only(body, ["id", "command", "env", "cwd", "agent", "stdin"]);
        if (body.stdin !== undefined && typeof body.stdin !== "string") {
          throw new FactoryError("stdin must be base64 text");
        }
        const env = { ...stringRecord(body.env, "exec's environment") };
        for (const name of AGENT_CREDENTIAL_NAMES) {
          if (name in env) {
            throw new FactoryError(
              `${name} is set by the broker for agent commands, not by callers`,
            );
          }
        }
        if (body.agent !== undefined && typeof body.agent !== "boolean") {
          throw new FactoryError("agent must be true or false");
        }
        if (body.cwd !== undefined && typeof body.cwd !== "string") {
          throw new FactoryError("cwd must be a path relative to the worktree");
        }
        if (body.agent === true) {
          if (credential === null) {
            throw new FactoryError(
              "no Workset agent credential is configured; set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
            );
          }
          env[credential.name] = credential.value;
        }
        const result = await runtime.exec({
          id: body.id as string,
          command: body.command as string[],
          env,
          cwd: body.cwd as string | undefined,
          ...(typeof body.stdin === "string"
            ? { stdin: new Uint8Array(Buffer.from(body.stdin, "base64")) }
            : {}),
        });
        return result;
      }
      default:
        throw new FactoryError(`the broker has no operation ${JSON.stringify(operation)}`);
    }
  };
}

/** `POST /v1/<operation>` with a JSON object; answers `{ ok, result | error }`. */
export async function handleRequest(handler: BrokerHandler, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/v1\/([a-z]+)$/.exec(url.pathname);
  if (request.method !== "POST" || !match) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "the request is not JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { ok: false, error: "the request must be a JSON object" },
      { status: 400 },
    );
  }
  try {
    return Response.json({ ok: true, result: await handler(match[1]!, body as Body) });
  } catch (error) {
    if (error instanceof FactoryError) {
      return Response.json({ ok: false, error: error.message }, { status: 400 });
    }
    // Never echo an unexpected error: it could carry anything, the credential included.
    process.stderr.write(
      `mate factory: unexpected error in ${match[1]}: ${(error as Error).name}\n`,
    );
    return Response.json({ ok: false, error: "the broker failed unexpectedly" }, { status: 500 });
  }
}

/** The broker serves on Bun, as Studio does; named here rather than typed globally. */
interface BunRuntime {
  serve(options: { unix: string; fetch: (request: Request) => Promise<Response> }): {
    stop(closeActiveConnections?: boolean): void;
  };
}

export function serveBroker(socket: string, handler: BrokerHandler): { stop: () => void } {
  const runtime = (globalThis as unknown as { Bun?: BunRuntime }).Bun;
  if (!runtime) throw new FactoryError("the factory broker requires the Bun runtime");
  const server = runtime.serve({
    unix: socket,
    fetch: (request: Request) => handleRequest(handler, request),
  });
  return { stop: () => server.stop(true) };
}
