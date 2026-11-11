import { TERMINAL_WASM } from "@uniqbit/mate-core/studio";
import { useEffect, useRef, useState } from "react";

import { Spinner } from "../components/ui/spinner";
import { openTerminalSocket, parseMessage, sendMessage } from "./socket";
import { loadWTerm, type WTermInstance } from "./wterm";

/** What covers the terminal: a spinner until the session's first output, or why it did not start. */
type SessionPhase = { kind: "starting" } | { kind: "refused"; reason: string } | { kind: "live" };

/** What the terminal says when its session ends: Claude's quit and the Outcome's return are told apart. */
function endNotice(message: { type: string; reason?: string; status?: number }): string {
  if (message.reason === "returned") return "The Outcome is back with automation.";
  if (message.reason === "deleted") return "The Outcome was deleted.";
  if (message.type === "ended") {
    return "The session ended. Return to automation when you are done, or close and reopen the Outcome to start it again.";
  }
  if (message.status === 0 || message.status === 130) {
    return "Claude closed. The Outcome returns to automation; if it does not, return it with the button.";
  }
  return "Claude stopped unexpectedly. The Outcome stays with you; return it to automation when you are done.";
}

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
  /** Set at the first output, or when the session ended: from then on reasons are notices. */
  private live = false;
  /** A `gone` answer restarts once; the next `ready` clears it. */
  private restarted = false;
  /** Set while an `attach` awaits its `ready`. */
  private attaching = false;

  constructor(
    private readonly mount: HTMLElement,
    private readonly outcome: string,
    private readonly companion: string,
    private readonly failed: () => void,
    private readonly phase: (phase: SessionPhase) => void,
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
      if (this.sessionId) {
        this.attaching = true;
        this.send({ type: "attach", sessionId: this.sessionId, cols, rows });
      } else this.start();
    };
    ws.onmessage = (event) => this.receive(event.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.live && !this.closed) {
        this.show({ kind: "refused", reason: "The connection closed before the session started." });
      }
    };
  }

  private receive(data: unknown): void {
    const term = this.term;
    if (!term) return;
    if (typeof data !== "string") {
      if (!this.live) this.show({ kind: "live" });
      term.write(new Uint8Array(data as ArrayBuffer));
      return;
    }
    const message = parseMessage<{
      type: string;
      sessionId?: string;
      reason?: string;
      status?: number;
    }>(data);
    if (!message) return;
    if (message.type === "ready") {
      this.restarted = false;
      this.sessionId = message.sessionId ?? null;
      // A reattached session may stay silent; only a fresh start waits for its first output.
      if (this.attaching) this.show({ kind: "live" });
      this.attaching = false;
      // A full reset: the replay that follows starts from a clean screen.
      term.write("\u001bc");
      if (this.focus) term.focus();
    } else if (message.type === "gone") {
      this.sessionId = null;
      this.attaching = false;
      // One silent restart; a session that is gone again at once must not loop.
      if (this.restarted) {
        this.show({ kind: "refused", reason: "The session could not be started." });
        return;
      }
      this.restarted = true;
      this.show({ kind: "starting" });
      this.start();
    } else if (message.type === "exit" || message.type === "ended") {
      this.sessionId = null;
      this.show({ kind: "live" });
      this.notice(endNotice(message));
    } else if (message.type === "takenOver") {
      this.notice("Another tab has this session now.");
    } else if (message.type === "error" && message.reason) {
      if (this.live) this.notice(message.reason);
      else this.show({ kind: "refused", reason: message.reason });
    }
  }

  private show(phase: SessionPhase): void {
    this.live = phase.kind === "live";
    this.phase(phase);
  }

  /** Starts again after a refusal. */
  retry(): void {
    this.restarted = false;
    this.show({ kind: "starting" });
    this.start();
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
  const [phase, setPhase] = useState<SessionPhase>({ kind: "starting" });
  // Another Outcome or companion is a new session: its cover starts over, set during render.
  const key = `${companion}\n${outcome}`;
  const [sessionKey, setSessionKey] = useState(key);
  if (sessionKey !== key) {
    setSessionKey(key);
    setPhase({ kind: "starting" });
  }
  // Read once per session: a later change of how the dialog was reached must not restart it.
  const focusOnReady = useRef(focus);
  const current = useRef<OutcomeSession | null>(null);
  useEffect(() => {
    const session = new OutcomeSession(
      mount.current!,
      outcome,
      companion,
      () => setFailed(true),
      setPhase,
      focusOnReady.current,
    );
    current.current = session;
    return () => session.close();
  }, [outcome, companion]);
  return (
    <div className="outcome-terminal-frame">
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
      {phase.kind === "live" || failed ? null : (
        <div
          className="outcome-terminal-cover"
          role={phase.kind === "refused" ? "alert" : "status"}
          data-terminal-phase={phase.kind}
        >
          {phase.kind === "refused" ? (
            <>
              <p>{phase.reason}</p>
              <button type="button" onClick={() => current.current?.retry()}>
                Try again
              </button>
            </>
          ) : (
            <>
              <Spinner aria-hidden="true" className="size-7 text-accent" />
              <p>Starting the session…</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
