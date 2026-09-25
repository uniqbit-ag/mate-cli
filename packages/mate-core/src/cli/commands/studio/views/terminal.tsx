/** @jsxImportSource hono/jsx */

import type { TerminalAgent } from "../terminal";
import type { StudioTerminalPage } from "./model";

export const TERMINAL_TAB_KEY = "mate-studio-terminal-tab";
export const TERMINAL_SESSION_KEY = "mate-studio-terminal-session";

const AGENT_LABELS: Record<TerminalAgent, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
};

export function TerminalPanel({ terminal }: { terminal: StudioTerminalPage }) {
  const target = terminal.target;
  return (
    <section
      className="panel terminal-panel"
      id="studio-terminal-panel"
      aria-label="Agent terminal"
      data-terminal-companion={target?.digest}
    >
      <header className="terminal-head">
        <div>
          <h2>Agent terminal</h2>
          <p className="terminal-target">
            {target ? (
              <>
                Launches against <code>{target.path}</code>
                {terminal.pinned ? " (fixed when Studio started)" : null}
              </>
            ) : (
              "Select a registered companion to launch an agent."
            )}
          </p>
        </div>
        <div className="terminal-actions">
          {target && terminal.agents.length > 0 ? (
            terminal.agents.map((agent) => (
              <button type="button" className="button" data-terminal-start={agent}>
                Start {AGENT_LABELS[agent]}
              </button>
            ))
          ) : target ? (
            <span className="empty">No agent this companion allows is installed.</span>
          ) : null}
          <button type="button" className="button" id="terminal-reconnect" hidden>
            Reconnect
          </button>
        </div>
      </header>
      <p className="terminal-status" id="terminal-status" role="status">
        Connecting…
      </p>
      <div className="terminal-view" id="studio-terminal" />
      <h3 className="terminal-sessions-title">Sessions</h3>
      <ul className="terminal-sessions" id="terminal-sessions" />
    </section>
  );
}

/**
 * Drives the xterm.js view over the terminal WebSocket. The tab id lives in
 * `sessionStorage`, so a reload keeps it and a new tab gets its own; a
 * taken-over tab never reconnects on its own.
 */
export const STUDIO_TERMINAL_SCRIPT = `(function () {
  var panel = document.getElementById("studio-terminal-panel");
  var mount = document.getElementById("studio-terminal");
  if (!panel || !mount || typeof Terminal === "undefined") return;
  var statusNode = document.getElementById("terminal-status");
  var reconnectButton = document.getElementById("terminal-reconnect");
  var list = document.getElementById("terminal-sessions");
  var companion = panel.getAttribute("data-terminal-companion") || "";
  var MAX_ATTEMPTS = 8;
  var FIRST_DELAY = 2000;

  function store(key, value) {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch (error) { /* a blocked store only costs the reattach */ }
  }
  function load(key) {
    try { return sessionStorage.getItem(key); } catch (error) { return null; }
  }
  var tabId = load(${JSON.stringify(TERMINAL_TAB_KEY)});
  if (!tabId) {
    tabId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2);
    store(${JSON.stringify(TERMINAL_TAB_KEY)}, tabId);
  }

  var term = new Terminal({ cursorBlink: true, allowProposedApi: true, fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono") || "monospace", fontSize: 13 });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.loadAddon(new ClipboardAddon.ClipboardAddon());
  term.open(mount);
  fit.fit();

  var ws = null;
  var attempts = 0;
  var takenOver = false;
  var pending = null;

  function status(text) { if (statusNode) statusNode.textContent = text; }
  function currentSession() { return load(${JSON.stringify(TERMINAL_SESSION_KEY)}); }
  function size() { return { cols: term.cols, rows: term.rows }; }
  function send(message) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(message)); return true; }
    return false;
  }
  function attach(sessionId) {
    var message = { type: "attach", sessionId: sessionId, tabId: tabId, cols: term.cols, rows: term.rows };
    if (!send(message)) { pending = message; connect(); }
  }

  function connect() {
    if (ws && ws.readyState <= 1) return;
    takenOver = false;
    if (reconnectButton) reconnectButton.hidden = true;
    ws = new WebSocket((location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/api/terminal");
    ws.binaryType = "arraybuffer";
    ws.onopen = function () {
      attempts = 0;
      status("Connected.");
      if (pending) { ws.send(JSON.stringify(pending)); pending = null; }
      else if (currentSession()) attach(currentSession());
    };
    ws.onmessage = function (event) {
      if (typeof event.data !== "string") { term.write(new Uint8Array(event.data)); return; }
      var message;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (message.type === "ready") {
        store(${JSON.stringify(TERMINAL_SESSION_KEY)}, message.sessionId);
        term.reset();
        status("Connected to " + message.agent + " in " + message.companionPath + ".");
        term.focus();
      } else if (message.type === "exit") {
        store(${JSON.stringify(TERMINAL_SESSION_KEY)}, null);
        status("The agent exited with status " + message.status + ".");
      } else if (message.type === "ended") {
        store(${JSON.stringify(TERMINAL_SESSION_KEY)}, null);
        status("The session ended" + (message.reason ? ": " + message.reason : "") + ".");
      } else if (message.type === "detached") {
        status("Detached (" + message.reason + "); the agent keeps running.");
      } else if (message.type === "takenOver") {
        takenOver = true;
        status("Another tab took over this session.");
        if (reconnectButton) reconnectButton.hidden = false;
      } else if (message.type === "gone") {
        store(${JSON.stringify(TERMINAL_SESSION_KEY)}, null);
        status("That session no longer exists.");
      } else if (message.type === "error") {
        status(message.reason);
      }
      refreshSessions();
    };
    ws.onclose = function () {
      ws = null;
      if (takenOver) return;
      if (attempts >= MAX_ATTEMPTS) {
        status("Disconnected.");
        if (reconnectButton) reconnectButton.hidden = false;
        return;
      }
      var delay = FIRST_DELAY * Math.pow(2, attempts);
      attempts += 1;
      status("Reconnecting (attempt " + attempts + " of " + MAX_ATTEMPTS + ")…");
      setTimeout(connect, delay);
    };
  }

  term.onData(function (data) { send({ type: "input", data: data }); });
  term.onResize(function (next) { send({ type: "resize", cols: next.cols, rows: next.rows }); });
  window.addEventListener("resize", function () { fit.fit(); });

  Array.prototype.forEach.call(document.querySelectorAll("[data-terminal-start]"), function (button) {
    button.addEventListener("click", function () {
      var dims = size();
      var message = { type: "start", agent: button.getAttribute("data-terminal-start"), companion: companion, tabId: tabId, cols: dims.cols, rows: dims.rows };
      if (!send(message)) { pending = message; connect(); }
    });
  });
  if (reconnectButton) reconnectButton.addEventListener("click", function () { attempts = 0; connect(); });

  function age(seconds) {
    if (seconds < 60) return seconds + " s";
    if (seconds < 3600) return Math.floor(seconds / 60) + " min";
    return Math.floor(seconds / 3600) + " h";
  }
  function button(label, onClick) {
    var node = document.createElement("button");
    node.type = "button";
    node.className = "button";
    node.textContent = label;
    node.addEventListener("click", onClick);
    return node;
  }
  function refreshSessions() {
    if (!list) return;
    fetch("/api/terminal/sessions", { credentials: "same-origin" }).then(function (response) {
      return response.ok ? response.json() : { sessions: [] };
    }).then(function (body) {
      while (list.firstChild) list.removeChild(list.firstChild);
      var mine = currentSession();
      if (!body.sessions.length) {
        var empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "No sessions are running.";
        list.appendChild(empty);
      }
      body.sessions.forEach(function (session) {
        var item = document.createElement("li");
        var label = document.createElement("span");
        label.textContent = session.agent + " · " + session.companionPath + " · " + (session.id === mine ? "this tab" : session.attached ? "attached elsewhere" : "detached") + " · " + age(session.ageSeconds);
        item.appendChild(label);
        if (session.id !== mine) item.appendChild(button(session.attached ? "Take over" : "Attach", function () { attach(session.id); }));
        item.appendChild(button("End", function () {
          fetch("/api/terminal/sessions/end", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: session.id }) }).then(refreshSessions);
        }));
        list.appendChild(item);
      });
    }).catch(function () { /* the next refresh retries */ });
  }

  connect();
  refreshSessions();
  setInterval(refreshSessions, 5000);
})();`;
