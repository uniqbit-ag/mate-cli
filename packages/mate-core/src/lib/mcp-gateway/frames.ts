/**
 * Wire format between shim and daemon: newline-delimited JSON. MCP JSON-RPC
 * frames pass through verbatim; gateway control frames are objects with a
 * single top-level `mate` key, which is never a valid JSON-RPC message.
 */

export interface HelloControl {
  type: "hello";
  version: string;
  cwd: string;
}

export interface WelcomeControl {
  type: "welcome";
  version: string;
  pid: number;
}

export interface DrainControl {
  type: "drain";
}

export interface DrainingControl {
  type: "draining";
}

export interface StatusRequestControl {
  type: "status";
}

export interface StatusReplyControl {
  type: "status-reply";
  status: unknown;
}

export type GatewayControl =
  | HelloControl
  | WelcomeControl
  | DrainControl
  | DrainingControl
  | StatusRequestControl
  | StatusReplyControl;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type GatewayFrame =
  | { kind: "control"; control: GatewayControl }
  | { kind: "rpc"; message: JsonRpcMessage }
  | { kind: "invalid"; line: string; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseFrame(line: string): GatewayFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "invalid", line, reason: "not JSON" };
  }
  if (!isRecord(parsed)) return { kind: "invalid", line, reason: "not an object" };
  if (isRecord(parsed.mate)) {
    const control = parsed.mate;
    if (typeof control.type !== "string") {
      return { kind: "invalid", line, reason: "control frame without type" };
    }
    return { kind: "control", control: control as unknown as GatewayControl };
  }
  if (parsed.jsonrpc === "2.0") {
    return { kind: "rpc", message: parsed as unknown as JsonRpcMessage };
  }
  return { kind: "invalid", line, reason: "neither control nor JSON-RPC" };
}

export function encodeControl(control: GatewayControl): string {
  return `${JSON.stringify({ mate: control })}\n`;
}

export function encodeRpc(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Buffering NDJSON splitter; feed raw chunks, get complete lines. */
export function createLineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  };
}
