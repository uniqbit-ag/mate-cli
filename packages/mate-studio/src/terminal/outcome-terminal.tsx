import { TERMINAL_WASM } from "@uniqbit/mate-core/studio";
import { useEffect, useRef, useState } from "react";

import { openTerminalSocket, parseMessage, sendMessage } from "./socket";
import { loadWTerm, type WTermInstance } from "./wterm";

/**
 * One Outcome's Workset session in a terminal view: starts it, or attaches to the live one,
 * and restarts a session that went away. Closing only detaches; the session keeps running for
 * its detach window.
 */
class OutcomeSession {
  private term: WTermInstance | null = null;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private observer: ResizeObserver | null = null;
  private closed = false;

  constructor(
    private readonly mount: HTMLElement,
    private readonly outcome: string,
    private readonly companion: string,
    private readonly failed: () => void,
    /** Takes keyboard focus when ready; off when the dialog was reached by stepping. */
    private readonly focus: boolean,
  ) {
    void this.open();
  }

  private async open(): Promise<void> {
    try {
      const WTerm = await loadWTerm();
      if (this.closed) return;
      const term = new WTerm(this.mount, {
        cursorBlink: true,
        autoResize: false,
        wasmUrl: TERMINAL_WASM,
      });
      this.term = term;
      term.onData = (data) => this.send({ type: "input", data });
      term.onResize = () => this.send({ type: "resize", cols: term.cols, rows: term.rows });
      await term.init();
      if (this.closed) return;
      term.fit();
      this.observer = new ResizeObserver(() => {
        if (this.mount.clientWidth && this.mount.clientHeight) term.fit();
      });
      this.observer.observe(this.mount);
      this.connect();
    } catch {
      this.term = null;
      this.failed();
    }
  }

  private send(message: object): void {
    sendMessage(this.ws, message);
  }

  private notice(text: string): void {
    this.term?.write(`\r\n\u001b[2m${text}\u001b[0m\r\n`);
  }

  private start(): void {
    if (!this.term) return;
    const { cols, rows } = this.term;
    this.send({ type: "start", workset: this.outcome, companion: this.companion, cols, rows });
  }

  private connect(): void {
    const ws = openTerminalSocket();
    this.ws = ws;
    ws.onopen = () => {
      if (!this.term) return;
      const { cols, rows } = this.term;
      if (this.sessionId) this.send({ type: "attach", sessionId: this.sessionId, cols, rows });
      else this.start();
    };
    ws.onmessage = (event) => this.receive(event.data);
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
    };
  }

  private receive(data: unknown): void {
    const term = this.term;
    if (!term) return;
    if (typeof data !== "string") {
      term.write(new Uint8Array(data as ArrayBuffer));
      return;
    }
    const message = parseMessage<{ type: string; sessionId?: string; reason?: string }>(data);
    if (!message) return;
    if (message.type === "ready") {
      this.sessionId = message.sessionId ?? null;
      // A full reset: the replay that follows starts from a clean screen.
      term.write("\u001bc");
      if (this.focus) term.focus();
    } else if (message.type === "gone") {
      this.sessionId = null;
      this.start();
    } else if (message.type === "exit" || message.type === "ended") {
      this.sessionId = null;
      this.notice(
        "The session ended. Return to automation when you are done, or close and reopen the Outcome to start it again.",
      );
    } else if (message.type === "takenOver") {
      this.notice("Another tab has this session now.");
    } else if (message.type === "error" && message.reason) {
      this.notice(message.reason);
    }
  }

  close(): void {
    this.closed = true;
    this.observer?.disconnect();
    this.ws?.close();
    this.ws = null;
    this.term?.destroy();
    this.term = null;
  }
}

/** The taken-over session inside an Outcome's dialog; mounting starts or attaches, unmounting detaches. */
export function OutcomeTerminal({
  outcome,
  companion,
  focus = true,
}: {
  outcome: string;
  companion: string;
  focus?: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Read once per session: a later change of how the dialog was reached must not restart it.
  const focusOnReady = useRef(focus);
  useEffect(() => {
    const session = new OutcomeSession(
      mount.current!,
      outcome,
      companion,
      () => setFailed(true),
      focusOnReady.current,
    );
    return () => session.close();
  }, [outcome, companion]);
  return (
    <div
      ref={mount}
      className="outcome-terminal"
      data-outcome-terminal={outcome}
      data-companion={companion}
      data-terminal-error={failed ? "" : undefined}
    >
      {failed
        ? "The terminal could not start in this browser. Close and reopen the Outcome to retry."
        : null}
    </div>
  );
}
