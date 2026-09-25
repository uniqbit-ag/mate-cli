/** @jsxImportSource hono/jsx */

import type { TerminalAgent } from "../terminal";
import type { StudioTerminalPage } from "./model";

export const TERMINAL_TAB_KEY = "mate-studio-terminal-tab";
export const TERMINAL_SESSION_KEY = "mate-studio-terminal-session";

const AGENT_LABELS: Record<TerminalAgent, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
};

export const TERMINAL_WIDTH_KEY = "mate-studio-terminal-width";
export const TERMINAL_COLLAPSED_KEY = "mate-studio-terminal-collapsed";
const TERMINAL_MIN_WIDTH = 360;
const TERMINAL_MAX_WIDTH_RATIO = 0.7;

/** Shared by the prepaint and sidebar scripts so both clamp alike. */
const CLAMP_WIDTH_SOURCE = `function clampWidth(px) {
    return Math.round(Math.max(${TERMINAL_MIN_WIDTH}, Math.min(px, window.innerWidth * ${TERMINAL_MAX_WIDTH_RATIO})));
  }`;

/**
 * A direct grid child of `.shell`: sticky positioning breaks under an ancestor
 * that sets `overflow`, and `.main` is not guaranteed to stay free of one.
 */
export function TerminalSidebar({ terminal }: { terminal: StudioTerminalPage }) {
  const target = terminal.target;
  return (
    <aside
      className="terminal-sidebar"
      id="studio-terminal-panel"
      aria-label="Agent terminal"
      data-terminal-companion={target?.digest}
      data-terminal-state="reconnecting"
    >
      <div
        className="terminal-resize"
        id="terminal-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the terminal"
      />
      <div className="terminal-strip">
        <button
          type="button"
          className="terminal-icon-button"
          id="terminal-expand"
          aria-controls="terminal-body"
          aria-expanded="false"
          aria-label="Expand the terminal"
        >
          ‹
        </button>
        <span className="terminal-dot" aria-hidden="true" />
      </div>
      <div className="terminal-body" id="terminal-body">
        <header className="terminal-head">
          <div className="terminal-title">
            <span className="terminal-dot" aria-hidden="true" />
            <h2>Agent terminal</h2>
            <button
              type="button"
              className="terminal-icon-button"
              id="terminal-collapse"
              aria-controls="terminal-body"
              aria-expanded="true"
              aria-label="Collapse the terminal"
            >
              ›
            </button>
            <button
              type="button"
              className="terminal-icon-button"
              id="terminal-drawer-close"
              aria-label="Close the terminal"
            >
              ×
            </button>
          </div>
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
          <div className="terminal-actions">
            {target && terminal.agents.length > 0 ? (
              terminal.agents.map((agent) => (
                <button key={agent} type="button" className="button" data-terminal-start={agent}>
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
          <p className="terminal-status" id="terminal-status" role="status">
            Connecting…
          </p>
        </header>
        <div className="terminal-view" id="studio-terminal" />
        <footer className="terminal-sessions-footer">
          <h3 className="terminal-sessions-title">Sessions</h3>
          <ul className="terminal-sessions" id="terminal-sessions" />
        </footer>
      </div>
    </aside>
  );
}

/** Outside `.shell`, so it never takes a grid cell; shown only below the side-by-side breakpoint. */
export function TerminalDrawerButton() {
  return (
    <button
      type="button"
      className="terminal-drawer-open"
      id="terminal-drawer-open"
      aria-controls="studio-terminal-panel"
      aria-expanded="false"
    >
      Terminal
    </button>
  );
}

/**
 * Runs in `<head>` with the terminal only, so a navigation paints the
 * remembered width and collapsed state instead of the defaults first.
 */
export const STUDIO_TERMINAL_PREPAINT_SCRIPT = `(function () {
  ${CLAMP_WIDTH_SOURCE}
  try {
    var width = parseInt(localStorage.getItem(${JSON.stringify(TERMINAL_WIDTH_KEY)}) || "", 10);
    if (width > 0) document.documentElement.style.setProperty("--terminal-width", clampWidth(width) + "px");
    if (localStorage.getItem(${JSON.stringify(TERMINAL_COLLAPSED_KEY)}) === "true") {
      document.documentElement.setAttribute("data-terminal-collapsed", "");
    }
  } catch (error) {
    /* a blocked web store only costs the preference, never the page */
  }
})();`;

/**
 * The sidebar chrome: collapse, drag-to-resize, and the narrow-window drawer.
 * It never touches xterm.js or the socket; the terminal script refits from
 * its own observer whenever this changes the terminal's size.
 */
export const STUDIO_TERMINAL_SIDEBAR_SCRIPT = `(function () {
  var root = document.documentElement;
  var panel = document.getElementById("studio-terminal-panel");
  if (!panel) return;
  var collapseButton = document.getElementById("terminal-collapse");
  var expandButton = document.getElementById("terminal-expand");
  var handle = document.getElementById("terminal-resize");
  var opener = document.getElementById("terminal-drawer-open");
  var closer = document.getElementById("terminal-drawer-close");
  ${CLAMP_WIDTH_SOURCE}
  function save(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* only the preference is lost */ }
  }

  function updateCollapseControls(collapsed) {
    if (collapseButton) collapseButton.setAttribute("aria-expanded", String(!collapsed));
    if (expandButton) expandButton.setAttribute("aria-expanded", String(!collapsed));
  }
  function setCollapsed(collapsed) {
    if (collapsed) root.setAttribute("data-terminal-collapsed", "");
    else root.removeAttribute("data-terminal-collapsed");
    updateCollapseControls(collapsed);
    save(${JSON.stringify(TERMINAL_COLLAPSED_KEY)}, String(collapsed));
  }
  updateCollapseControls(root.hasAttribute("data-terminal-collapsed"));
  if (collapseButton) collapseButton.addEventListener("click", function () { setCollapsed(true); });
  if (expandButton) expandButton.addEventListener("click", function () { setCollapsed(false); });

  if (handle) {
    var dragging = false;
    var width = 0;
    handle.addEventListener("pointerdown", function (event) {
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      width = clampWidth(window.innerWidth - event.clientX);
      root.style.setProperty("--terminal-width", width + "px");
    });
    var stop = function (event) {
      if (!dragging) return;
      dragging = false;
      if (handle.hasPointerCapture && handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (width > 0) save(${JSON.stringify(TERMINAL_WIDTH_KEY)}, String(width));
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  function setDrawer(open) {
    if (open) panel.setAttribute("data-drawer-open", "");
    else panel.removeAttribute("data-drawer-open");
    if (opener) opener.setAttribute("aria-expanded", String(open));
  }
  if (opener) opener.addEventListener("click", function () {
    setDrawer(true);
    if (closer) closer.focus();
  });
  if (closer) closer.addEventListener("click", function () {
    setDrawer(false);
    if (opener) opener.focus();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || !panel.hasAttribute("data-drawer-open")) return;
    setDrawer(false);
    if (opener) opener.focus();
  });
})();`;

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
  var opened = false;
  var frame = 0;
  /**
   * xterm.js measures its cells on open, so a sidebar collapsed at load opens
   * it only once the area is visible. A zero size never fits: it would send a
   * resize the server rejects.
   */
  function fitNow() {
    frame = 0;
    if (!mount.clientWidth || !mount.clientHeight) return;
    if (!opened) { term.open(mount); opened = true; }
    fit.fit();
  }
  function scheduleFit() { if (!frame) frame = requestAnimationFrame(fitNow); }
  new ResizeObserver(scheduleFit).observe(mount);
  fitNow();

  var ws = null;
  var attempts = 0;
  var takenOver = false;
  var pending = null;

  function status(text) { if (statusNode) statusNode.textContent = text; }
  function state(name) { panel.setAttribute("data-terminal-state", name); }
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
      state("connected");
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
        state("connected");
        status("Connected to " + message.agent + " in " + message.companionPath + ".");
        term.focus();
      } else if (message.type === "exit") {
        store(${JSON.stringify(TERMINAL_SESSION_KEY)}, null);
        state("detached");
        status("The agent exited with status " + message.status + ".");
      } else if (message.type === "ended") {
        store(${JSON.stringify(TERMINAL_SESSION_KEY)}, null);
        state("detached");
        status("The session ended" + (message.reason ? ": " + message.reason : "") + ".");
      } else if (message.type === "detached") {
        state("detached");
        status("Detached (" + message.reason + "); the agent keeps running.");
      } else if (message.type === "takenOver") {
        takenOver = true;
        state("detached");
        status("Another tab took over this session.");
        if (reconnectButton) reconnectButton.hidden = false;
      } else if (message.type === "gone") {
        store(${JSON.stringify(TERMINAL_SESSION_KEY)}, null);
        state("detached");
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
        state("detached");
        status("Disconnected.");
        if (reconnectButton) reconnectButton.hidden = false;
        return;
      }
      var delay = FIRST_DELAY * Math.pow(2, attempts);
      attempts += 1;
      state("reconnecting");
      status("Reconnecting (attempt " + attempts + " of " + MAX_ATTEMPTS + ")…");
      setTimeout(connect, delay);
    };
  }

  term.onData(function (data) { send({ type: "input", data: data }); });
  var sent = { cols: term.cols, rows: term.rows };
  term.onResize(function (next) {
    if (next.cols === sent.cols && next.rows === sent.rows) return;
    sent = { cols: next.cols, rows: next.rows };
    send({ type: "resize", cols: next.cols, rows: next.rows });
  });

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
