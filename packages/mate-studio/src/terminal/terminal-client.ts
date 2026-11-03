import { TERMINAL_WASM } from "@uniqbit/mate-core/studio";
import { TERMINAL_SESSION_KEY, TERMINAL_TAB_KEY } from "./keys";

import { openTerminalSocket, parseMessage, sendMessage } from "./socket";
import type { WTermConstructor, WTermInstance } from "./wterm";

export type TerminalState = "connected" | "reconnecting" | "detached";

/** What the sidebar shows; the client reports, React renders. */
export interface TerminalClientEvents {
  state(state: TerminalState): void;
  status(text: string): void;
  reconnectable(shown: boolean): void;
  /** The agent this tab views, `"pending"` while a stored session reattaches, or `null`. */
  viewing(agent: string | null): void;
  /** Any server message; the session list refreshes. */
  changed(): void;
}

const MAX_ATTEMPTS = 8;
const FIRST_DELAY = 2000;

function load(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* a blocked store only costs the reattach */
  }
}

/** The session this tab views, kept across reloads so it reattaches. */
export function storedSession(): string | null {
  return load(TERMINAL_SESSION_KEY);
}

/** The tab id lives in `sessionStorage`, so a reload keeps it and a new tab gets its own. */
function tabId(): string {
  let id = load(TERMINAL_TAB_KEY);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
    store(TERMINAL_TAB_KEY, id);
  }
  return id;
}

type Message = Record<string, unknown> & { type: string };

/**
 * Drives the sidebar's wterm view over the terminal WebSocket: start, attach, take over,
 * reconnect with backoff, and a full reset before each replay. A taken-over tab never
 * reconnects on its own. Created once per mount; data updates never touch it.
 */
export class TerminalClient {
  private readonly term: WTermInstance;
  private readonly tab = tabId();
  private ws: WebSocket | null = null;
  private attempts = 0;
  private takenOver = false;
  private pending: Message | null = null;
  private opened = false;
  private initialized = false;
  private frame = 0;
  private queued: (string | Uint8Array)[] = [];
  private sent: { cols: number; rows: number };
  private readonly resize: ResizeObserver;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private readonly mount: HTMLElement,
    WTerm: WTermConstructor,
    private readonly companion: string,
    private readonly events: TerminalClientEvents,
  ) {
    this.term = new WTerm(mount, {
      cursorBlink: true,
      autoResize: false,
      wasmUrl: TERMINAL_WASM,
      // An application's clipboard write goes through the browser's own permission.
      onClipboardWrite: (text) => void navigator.clipboard?.writeText(text).catch(() => {}),
    });
    this.sent = { cols: this.term.cols, rows: this.term.rows };
    this.term.onData = (data) => void this.send({ type: "input", data });
    this.term.onResize = () => this.sendSize();
    if (storedSession()) events.viewing("pending");
    this.resize = new ResizeObserver(() => this.scheduleFit());
    this.resize.observe(mount);
    this.fitNow();
    this.connect();
  }

  private write(data: string | Uint8Array): void {
    if (this.initialized) this.term.write(data);
    else this.queued.push(data);
  }

  /**
   * wterm measures its cells on init, so a sidebar collapsed at load starts it only once the
   * area is visible. A zero size never fits: it would send a resize the server rejects.
   */
  private fitNow(): void {
    this.frame = 0;
    if (!this.mount.clientWidth || !this.mount.clientHeight) return;
    if (this.initialized) {
      this.term.fit();
      return;
    }
    if (this.opened) return;
    this.opened = true;
    this.term
      .init()
      .then(() => {
        if (this.destroyed) return;
        this.initialized = true;
        this.term.fit();
        for (const data of this.queued) this.term.write(data);
        this.queued = [];
        if (this.pending || this.ws) this.sendSize();
      })
      .catch(() => {
        this.opened = false;
        this.events.state("detached");
        this.events.status("The terminal could not start in this browser.");
        this.events.reconnectable(true);
      });
  }

  private scheduleFit(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.fitNow());
  }

  private send(message: Message): boolean {
    return sendMessage(this.ws, message);
  }

  private sendOrQueue(message: Message): void {
    if (!this.send(message)) {
      this.pending = message;
      this.connect();
    }
  }

  private sendSize(): void {
    const { cols, rows } = this.term;
    if (cols === this.sent.cols && rows === this.sent.rows) return;
    this.sent = { cols, rows };
    this.send({ type: "resize", cols, rows });
  }

  private connect(): void {
    if (this.destroyed || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.takenOver = false;
    this.events.reconnectable(false);
    const ws = openTerminalSocket();
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.events.state("connected");
      this.events.status("Connected.");
      if (this.pending) {
        ws.send(JSON.stringify(this.pending));
        this.pending = null;
      } else {
        const session = storedSession();
        if (session) this.attach(session);
      }
    };
    ws.onmessage = (event) => this.receive(event.data);
    ws.onclose = () => {
      this.ws = null;
      if (this.takenOver || this.destroyed) return;
      if (this.attempts >= MAX_ATTEMPTS) {
        this.events.state("detached");
        this.events.status("Disconnected.");
        this.events.reconnectable(true);
        return;
      }
      const delay = FIRST_DELAY * 2 ** this.attempts;
      this.attempts += 1;
      this.events.state("reconnecting");
      this.events.status(`Reconnecting (attempt ${this.attempts} of ${MAX_ATTEMPTS})…`);
      this.retry = setTimeout(() => this.connect(), delay);
    };
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") {
      this.write(new Uint8Array(data as ArrayBuffer));
      return;
    }
    const message = parseMessage<Message & { workset?: { id: string } }>(data);
    if (!message) return;
    const { events } = this;
    const lost = (text: string) => {
      store(TERMINAL_SESSION_KEY, null);
      events.viewing(null);
      events.state("detached");
      events.status(text);
    };
    if (message.type === "ready") {
      store(TERMINAL_SESSION_KEY, String(message.sessionId));
      events.viewing(String(message.agent));
      // A full reset: the replay that follows starts from a clean screen.
      this.write("\u001bc");
      events.state("connected");
      events.status(
        message.workset
          ? `Connected to Workset ${message.workset.id}.`
          : `Connected to ${String(message.agent)} in ${String(message.companionPath)}.`,
      );
      if (this.initialized) this.term.focus();
    } else if (message.type === "exit") {
      lost(`The agent exited with status ${String(message.status)}.`);
    } else if (message.type === "ended") {
      lost(`The session ended${message.reason ? `: ${String(message.reason)}` : ""}.`);
    } else if (message.type === "detached") {
      events.viewing(null);
      events.state("detached");
      events.status(`Detached (${String(message.reason)}); the agent keeps running.`);
    } else if (message.type === "takenOver") {
      events.viewing(null);
      this.takenOver = true;
      events.state("detached");
      events.status("Another tab took over this session.");
      events.reconnectable(true);
    } else if (message.type === "gone") {
      lost("That session no longer exists.");
    } else if (message.type === "error") {
      events.status(String(message.reason));
    }
    events.changed();
  }

  private size() {
    return { tabId: this.tab, cols: this.term.cols, rows: this.term.rows };
  }

  /** `task` carries a registered action and subject; the server builds the prompt from them. */
  start(agent: string, task?: { action: string; subject: string }): void {
    this.sendOrQueue({ type: "start", agent, companion: this.companion, ...this.size(), ...task });
  }

  /** A Factory Outcome names only its Workset; the server resolves everything else. */
  startWorkset(workset: string): void {
    this.sendOrQueue({ type: "start", workset, companion: this.companion, ...this.size() });
  }

  attach(sessionId: string): void {
    this.sendOrQueue({ type: "attach", sessionId, ...this.size() });
  }

  reconnect(): void {
    this.attempts = 0;
    if (!this.initialized) this.fitNow();
    this.connect();
  }

  /** Detaches only: the session keeps running for its detach window. */
  destroy(): void {
    this.destroyed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.ws?.close();
    this.ws = null;
    this.term.destroy();
  }
}
