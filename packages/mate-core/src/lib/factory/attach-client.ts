import net from "node:net";

import { readWorksets } from "../workset/record";
import { encodeControl, encodeData, FRAME_CONTROL, FrameDecoder } from "./frames";
import { FactoryError } from "./ids";

/**
 * The attach helper Studio's terminal runs in its PTY: it asks the broker to start the
 * Workset's agent and relays the terminal both ways. It holds no credential; the broker
 * adds it. Closing the helper closes the attach, which makes the broker stop the agent.
 */

export const ATTACH_STARTS = ["clarify", "explore", "continue"] as const;
export type AttachStart = (typeof ATTACH_STARTS)[number];

/** The managed launch inside the Workset container, with the server-built first turn. */
export function agentCommand(start: AttachStart, intent: string): string[] {
  const launch = ["mate", "claude", "--", "--yes"];
  if (start === "continue") return [...launch, "--continue"];
  if (start === "explore") return [...launch, "/mate-explore-change"];
  const text = intent.trim();
  return [...launch, text ? `/mate-clarify-intent ${text}` : "/mate-clarify-intent"];
}

export async function worksetIntent(companionPath: string, id: string): Promise<string> {
  const { worksets } = await readWorksets(companionPath);
  const record = worksets.find((workset) => workset.id === id);
  if (!record) throw new FactoryError(`no valid Workset ${id} in ${companionPath}`);
  return record.intent;
}

export interface AttachStreams {
  input: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => void; isTTY?: boolean };
  output: NodeJS.WritableStream & {
    columns?: number;
    rows?: number;
    on(event: "resize", listener: () => void): unknown;
  };
  error: NodeJS.WritableStream;
}

/** Resolves with the agent's exit status; an attach the broker refuses resolves 1. */
export function runAttach(
  socketPath: string,
  start: { id: string; session: string; command: string[] },
  streams: AttachStreams,
  connect: (path: string) => net.Socket = (path) => net.connect(path),
): Promise<number> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const decoder = new FrameDecoder();
    let status: number | null = null;
    const size = () => ({ cols: streams.output.columns ?? 80, rows: streams.output.rows ?? 24 });

    const finish = (code: number) => {
      if (streams.input.isTTY) streams.input.setRawMode?.(false);
      streams.input.removeListener("data", onInput);
      resolve(code);
    };
    const onInput = (chunk: Buffer | string) => {
      if (!socket.destroyed)
        socket.write(encodeData(typeof chunk === "string" ? chunk : new Uint8Array(chunk)));
    };

    socket.on("connect", () => {
      socket.write(encodeControl({ type: "start", ...start, agent: true, ...size() }));
      if (streams.input.isTTY) streams.input.setRawMode?.(true);
      streams.input.on("data", onInput);
      streams.output.on("resize", () => {
        if (!socket.destroyed) socket.write(encodeControl({ type: "resize", ...size() }));
      });
    });
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        if (frame.type !== FRAME_CONTROL) {
          streams.output.write(frame.data);
        } else if (frame.message.type === "exit") {
          status = typeof frame.message.status === "number" ? frame.message.status : 1;
        } else if (frame.message.type === "error") {
          streams.error.write(`mate factory attach: ${String(frame.message.reason)}\r\n`);
          status = 1;
        }
      }
    });
    socket.on("error", (error) => {
      streams.error.write(
        `mate factory attach: the factory broker is not reachable: ${error.message}\r\n`,
      );
      status = 1;
    });
    socket.on("close", () => finish(status ?? 1));
  });
}
