import { beforeEach, describe, expect, it, mock } from "bun:test";

await import("../../test/dom");
/** The terminal the loader hands out; each test sets its fake. */
const wterm: { Ctor: unknown } = { Ctor: null };
mock.module("./wterm", () => ({ loadWTerm: async () => wterm.Ctor }));
const { TERMINAL_SESSION_KEY } = await import("./keys");
const { TerminalClient } = await import("./terminal-client");

class FakeSocket {
  static last: FakeSocket;
  static OPEN = 1;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener(
    type: "open" | "message" | "close",
    listener: (event: { data: unknown }) => void,
  ) {
    if (type === "message") this.onmessage = listener;
    else this[`on${type}`] = () => listener({ data: undefined });
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

class FakeTerm {
  cols = 80;
  rows = 24;
  written: string[] = [];
  onData = null;
  onResize = null;
  init = () => Promise.resolve();
  fit() {}
  write(data: string) {
    this.written.push(String(data));
  }
  focus() {}
  destroy() {}
}

function client() {
  const seen = { state: "", status: "", reconnectable: false, viewing: null as string | null };
  const instance = new TerminalClient(
    document.createElement("div"),
    FakeTerm as never,
    "0123456789",
    {
      state: (state) => (seen.state = state),
      status: (status) => (seen.status = status),
      reconnectable: (shown) => (seen.reconnectable = shown),
      viewing: (agent) => (seen.viewing = agent),
      changed: () => {},
    },
  );
  return { instance, seen, socket: FakeSocket.last };
}

beforeEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  sessionStorage.clear();
});

describe("the agent terminal client", () => {
  it("starts an agent for the companion and remembers the session it gets", () => {
    const { instance, seen, socket } = client();
    socket.open();
    instance.start("claude");
    expect(socket.sent.at(-1)).toMatchObject({
      type: "start",
      agent: "claude",
      companion: "0123456789",
    });
    socket.receive({
      type: "ready",
      sessionId: "acme-session",
      agent: "claude",
      companionPath: "/acme",
    });
    expect(sessionStorage.getItem(TERMINAL_SESSION_KEY)).toBe("acme-session");
    expect(seen.viewing).toBe("claude");
    expect(seen.status).toBe("Connected to claude in /acme.");
    instance.destroy();
  });

  it("reattaches the remembered session when it connects", () => {
    sessionStorage.setItem(TERMINAL_SESSION_KEY, "acme-session");
    const { instance, seen, socket } = client();
    expect(seen.viewing).toBe("pending");
    socket.open();
    expect(socket.sent[0]).toMatchObject({ type: "attach", sessionId: "acme-session" });
    instance.destroy();
  });

  it("stops after another tab takes over and offers Reconnect", () => {
    const { instance, seen, socket } = client();
    socket.open();
    socket.receive({ type: "takenOver" });
    socket.onclose?.();
    expect(seen.state).toBe("detached");
    expect(seen.reconnectable).toBe(true);
    expect(FakeSocket.last).toBe(socket);
    instance.destroy();
  });

  it("forgets a session that no longer exists", () => {
    sessionStorage.setItem(TERMINAL_SESSION_KEY, "acme-session");
    const { instance, seen, socket } = client();
    socket.open();
    socket.receive({ type: "gone" });
    expect(sessionStorage.getItem(TERMINAL_SESSION_KEY)).toBeNull();
    expect(seen.viewing).toBeNull();
    instance.destroy();
  });

  it("starts a Workset session by its id only", () => {
    const { instance, socket } = client();
    socket.open();
    instance.startWorkset("acme-onboarding");
    expect(socket.sent.at(-1)).toMatchObject({
      type: "start",
      workset: "acme-onboarding",
      companion: "0123456789",
    });
    instance.destroy();
  });
});
