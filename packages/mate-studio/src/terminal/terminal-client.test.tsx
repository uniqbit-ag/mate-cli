import { beforeEach, describe, expect, it, mock } from "bun:test";

await import("../../test/dom");
/** The terminal the loader hands out; each test sets its fake. */
const wterm: { Ctor: unknown } = { Ctor: null };
mock.module("./wterm", () => ({ loadWTerm: async () => wterm.Ctor }));
const { TERMINAL_SESSION_KEY } = await import("./keys");
const { TerminalClient } = await import("./terminal-client");
const { act, render } = await import("@testing-library/react");
const { OutcomeTerminal } = await import("./outcome-terminal");

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

describe("the Workset session in an Outcome's dialog", () => {
  it("starts the Workset session when the dialog opens and only detaches when it closes", async () => {
    let destroyed = 0;
    wterm.Ctor = class extends FakeTerm {
      destroy() {
        destroyed += 1;
      }
    };
    const view = render(<OutcomeTerminal outcome="acme-login" companion="0123456789" />);
    await act(async () => {});
    const socket = FakeSocket.last;
    socket.open();
    expect(socket.sent[0]).toMatchObject({
      type: "start",
      workset: "acme-login",
      companion: "0123456789",
    });
    socket.receive({ type: "ready", sessionId: "acme-session" });
    view.unmount();
    // Closing detaches: the socket closes and the view goes, but no end is sent.
    expect(socket.readyState).toBe(3);
    expect(destroyed).toBe(1);
    expect(socket.sent.some((message) => message.type === "end")).toBe(false);
  });

  describe("the spinner", () => {
    const open = async () => {
      const written: string[] = [];
      wterm.Ctor = class extends FakeTerm {
        write(data: string) {
          written.push(String(data));
        }
      };
      const view = render(<OutcomeTerminal outcome="acme-login" companion="0123456789" />);
      await act(async () => {});
      FakeSocket.last.open();
      return { view, socket: FakeSocket.last, written };
    };

    it("shows from the start until Claude's first output", async () => {
      const { view, socket } = await open();
      const status = view.getByRole("status");
      expect(status.textContent).toContain("Starting the session");
      // Readiness alone is not output: Claude has drawn nothing yet.
      act(() => socket.receive({ type: "ready", sessionId: "acme-session" }));
      expect(view.queryByRole("status")).not.toBeNull();
      act(() => socket.onmessage?.({ data: new Uint8Array([0x1b]).buffer }));
      expect(view.queryByRole("status")).toBeNull();
      view.unmount();
    });

    it("gives way to the reason when the session is refused", async () => {
      const { view, socket } = await open();
      act(() =>
        socket.receive({ type: "error", reason: "the Workset's session could not be prepared" }),
      );
      const alert = view.getByRole("alert");
      expect(alert.textContent).toContain("the Workset's session could not be prepared");
      expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
      expect(view.queryByRole("status")).toBeNull();
      view.unmount();
    });

    it("offers Try again when the socket closes before any output", async () => {
      const { view, socket } = await open();
      act(() => socket.receive({ type: "ready", sessionId: "acme-session" }));
      act(() => socket.onclose?.());
      expect(view.getByRole("alert").textContent).toContain("closed before the session started");
      expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
      view.unmount();
    });

    it("is gone once the session ended, and a later reason is only a notice", async () => {
      const { view, socket, written } = await open();
      act(() => socket.receive({ type: "ready", sessionId: "acme-session" }));
      act(() => socket.receive({ type: "exit", status: 0 }));
      expect(view.queryByRole("status")).toBeNull();
      expect(written.join("")).toContain("Claude closed. The Outcome returns to automation");
      act(() => socket.receive({ type: "error", reason: "late" }));
      expect(view.queryByRole("alert")).toBeNull();
      view.unmount();
    });
  });

  it("takes focus when ready, unless the dialog was reached by stepping", async () => {
    const focused: boolean[] = [];
    for (const focus of [true, false]) {
      wterm.Ctor = class extends FakeTerm {
        focus() {
          focused.push(focus);
        }
      };
      const view = render(
        <OutcomeTerminal outcome="acme-login" companion="0123456789" focus={focus} />,
      );
      // oxlint-disable-next-line no-await-in-loop -- one terminal at a time
      await act(async () => {});
      FakeSocket.last.open();
      FakeSocket.last.receive({ type: "ready", sessionId: "acme-session" });
      view.unmount();
    }
    expect(focused).toEqual([true]);
  });
});
