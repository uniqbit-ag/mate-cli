import { TERMINAL_SOCKET_ROUTE } from "@uniqbit/mate-core/studio";

/** The terminal WebSocket on Studio's own origin; output arrives as binary frames. */
export function openTerminalSocket(): WebSocket {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${scheme}//${location.host}${TERMINAL_SOCKET_ROUTE}`);
  ws.binaryType = "arraybuffer";
  return ws;
}

/** Sends `message` as JSON only while the socket is open; reports whether it went out. */
export function sendMessage(ws: WebSocket | null, message: object): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

/** A text frame's control message, or `null` when it is not JSON. */
export function parseMessage<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
