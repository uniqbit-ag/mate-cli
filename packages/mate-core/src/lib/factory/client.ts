import path from "node:path";

import type { AgentCredentialName } from "./broker";
import type { CommandResult } from "./command";
import { FactoryError } from "./ids";
import type { ExecRequest, SpawnRequest, WorksetInfo } from "./runtime";

/** Where the factory supervisor tells Studio the broker listens; unset outside factory mode. */
export const FACTORY_BROKER_ENV = "MATE_FACTORY_BROKER";

export interface FactoryClient {
  spawn(request: SpawnRequest): Promise<WorksetInfo>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  delete(id: string, options?: { force?: boolean }): Promise<void>;
  exec(
    request: Omit<ExecRequest, "stdin"> & { agent?: boolean; stdin?: Uint8Array },
  ): Promise<CommandResult>;
  /** The Workset container's address on the inner network, for reaching a port inside it. */
  address(id: string): Promise<string>;
  list(): Promise<WorksetInfo[]>;
  /** Which Workset agent credential the broker holds, by name; null when none. */
  info(): Promise<{ credential: AgentCredentialName | null }>;
}

/** The broker serves attaches on a second socket beside its own. */
export function attachSocketFor(brokerSocket: string): string {
  return path.join(path.dirname(brokerSocket), "attach.sock");
}

/** The broker's client, or null outside factory mode. */
export function factoryClient(
  socket: string | undefined = process.env[FACTORY_BROKER_ENV],
  fetcher: typeof fetch = fetch,
): FactoryClient | null {
  if (!socket) return null;

  const call = async <T>(operation: string, body: object): Promise<T> => {
    let response: Response;
    try {
      response = await fetcher(`http://factory/v1/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        unix: socket,
      } as RequestInit);
    } catch (error) {
      throw new FactoryError(
        `the factory broker at ${socket} is not reachable: ${(error as Error).message}`,
      );
    }
    const answer = (await response.json()) as { ok: boolean; result?: T; error?: string };
    if (!answer.ok)
      throw new FactoryError(answer.error ?? "the factory broker refused the request");
    return answer.result as T;
  };

  return {
    spawn: (request) => call("spawn", request),
    pause: async (id) => void (await call("pause", { id })),
    resume: async (id) => void (await call("resume", { id })),
    delete: async (id, options = {}) =>
      void (await call(
        "delete",
        options.force === undefined ? { id } : { id, force: options.force },
      )),
    exec: ({ stdin, ...request }) =>
      call("exec", stdin ? { ...request, stdin: Buffer.from(stdin).toString("base64") } : request),
    address: async (id) => (await call<{ address: string }>("address", { id })).address,
    list: async () => (await call<{ worksets: WorksetInfo[] }>("list", {})).worksets,
    info: () => call("info", {}),
  };
}
