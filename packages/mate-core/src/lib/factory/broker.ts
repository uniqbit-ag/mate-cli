import {
  checkedCredential,
  credentialKind,
  type CredentialStore,
  NO_CREDENTIAL,
} from "./credential-store";
import { FactoryError } from "./ids";
import type { WorksetRuntime } from "./runtime";

export { AGENT_CREDENTIAL_NAMES, takeAgentCredential } from "./credential-store";

/**
 * The factory broker's API: the Workset operations and the Workset agent
 * credential, over HTTP on a Unix socket, and nothing else. It is the boundary
 * between processes running as the unprivileged user and the inner Docker
 * daemon, so every request is checked field by field and an unexpected field is
 * refused: callers cannot choose a mount, image, privilege or environment.
 * No answer carries the credential's value.
 */

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

export interface BrokerHandler {
  (operation: string, body: Body): Promise<unknown>;
}

export function brokerHandler(
  runtime: WorksetRuntime,
  credentials: CredentialStore,
): BrokerHandler {
  return async (operation, body) => {
    switch (operation) {
      case "spawn":
        only(body, ["id", "repository", "remoteUrl", "companion", "size"]);
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
      case "info": {
        only(body, []);
        // The kind only: callers may know whether an agent can start, never the value.
        const credential = credentials.current();
        return { credential: credential ? credentialKind(credential.name) : null };
      }
      case "credential.status":
        only(body, []);
        return credentials.status();
      case "credential.set":
        only(body, ["kind", "value"]);
        credentials.set(checkedCredential(body.kind, body.value));
        return {};
      case "credential.clear":
        only(body, []);
        credentials.clear();
        return {};
      case "exec": {
        only(body, ["id", "command", "cwd", "agent", "stdin"]);
        if (body.stdin !== undefined && typeof body.stdin !== "string") {
          throw new FactoryError("stdin must be base64 text");
        }
        if (body.agent !== undefined && typeof body.agent !== "boolean") {
          throw new FactoryError("agent must be true or false");
        }
        if (body.cwd !== undefined && typeof body.cwd !== "string") {
          throw new FactoryError("cwd must be a path relative to the worktree");
        }
        const credential = body.agent === true ? credentials.current() : undefined;
        if (credential === null) throw new FactoryError(NO_CREDENTIAL);
        const result = await runtime.exec(
          {
            id: body.id as string,
            command: body.command as string[],
            cwd: body.cwd as string | undefined,
            ...(typeof body.stdin === "string"
              ? { stdin: new Uint8Array(Buffer.from(body.stdin, "base64")) }
              : {}),
          },
          credential,
        );
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
  const match = /^\/v1\/([a-z]+(?:\.[a-z]+)*)$/.exec(url.pathname);
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
      return Response.json(
        { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: 400 },
      );
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
