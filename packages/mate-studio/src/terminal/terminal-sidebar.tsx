import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TERMINAL_SESSIONS_END_ROUTE,
  TERMINAL_SESSIONS_ROUTE,
  type TerminalAgent,
} from "@uniqbit/mate-core/studio";
import { type RefObject, useEffect, useRef, useState } from "react";

import type { ShellTerminal } from "../server/shell";
import { useTerminalUi } from "../stores/terminal-ui";
import { storedSession, TerminalClient, type TerminalState } from "./terminal-client";
import { loadWTerm } from "./wterm";

const AGENT_LABELS: Record<string, string> = { claude: "Claude Code", opencode: "OpenCode" };

interface TerminalSession {
  id: string;
  agent: TerminalAgent;
  companionPath: string;
  attached: boolean;
  ageSeconds: number;
  workset?: { id: string; title: string };
}

const sessionsKey = ["terminal-sessions"] as const;

function age(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}

/** Where a listed session is viewed, as seen from this tab. */
function viewedFrom(session: TerminalSession, mine: string | null): string {
  if (session.id === mine) return "this tab";
  return session.attached ? "attached elsewhere" : "detached";
}

function closeDrawer(setDrawerOpen: (open: boolean) => void): void {
  setDrawerOpen(false);
  document.getElementById("terminal-drawer-open")?.focus();
}

interface ActionChoice {
  action: string;
  subject: string;
  agents: string[];
}

/** Every running session, polled, and ending one. */
function useTerminalSessions() {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: async (): Promise<TerminalSession[]> => {
      const response = await fetch(TERMINAL_SESSIONS_ROUTE, { credentials: "same-origin" });
      return response.ok
        ? ((await response.json()) as { sessions: TerminalSession[] }).sessions
        : [];
    },
    refetchInterval: 5_000,
  });
  const end = useMutation({
    mutationFn: (id: string) =>
      fetch(TERMINAL_SESSIONS_END_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: sessionsKey }),
  });
  return { sessions: sessions.data, end: (id: string) => end.mutate(id) };
}

/**
 * The sidebar's terminal client for `companion`, and the controller other views reach it
 * through while the sidebar is mounted.
 */
function useTerminalClient(mount: RefObject<HTMLDivElement | null>, companion: string) {
  const client = useRef<TerminalClient | null>(null);
  const [state, setState] = useState<TerminalState>("reconnecting");
  const [status, setStatus] = useState("Connecting…");
  const [reconnectable, setReconnectable] = useState(false);
  const [choice, setChoice] = useState<ActionChoice | null>(null);
  const queryClient = useQueryClient();

  // The pre-paint script may have collapsed the sidebar already; the store follows it.
  useEffect(() => {
    useTerminalUi.setState({
      collapsed: document.documentElement.hasAttribute("data-terminal-collapsed"),
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    const setViewing = useTerminalUi.getState().setViewing;
    void loadWTerm().then(
      (WTerm) => {
        if (cancelled || !mount.current) return;
        client.current = new TerminalClient(mount.current, WTerm, companion, {
          state: setState,
          status: setStatus,
          reconnectable: setReconnectable,
          viewing: (agent) => {
            setViewing(agent);
            if (agent) setChoice(null);
          },
          changed: () => void queryClient.invalidateQueries({ queryKey: sessionsKey }),
        });
      },
      () => {
        setState("detached");
        setStatus("The terminal could not start in this browser.");
        setReconnectable(true);
      },
    );
    return () => {
      cancelled = true;
      client.current?.destroy();
      client.current = null;
      setViewing(null);
    };
  }, [mount, companion, queryClient]);

  useEffect(() => {
    const busy = () => {
      if (!useTerminalUi.getState().viewing) return false;
      setStatus("End the current session first.");
      return true;
    };
    useTerminalUi.getState().register({
      startWorkset: (id) => {
        useTerminalUi.getState().reveal();
        if (!busy()) client.current?.startWorkset(id);
      },
      attach: (sessionId) => {
        useTerminalUi.getState().reveal();
        client.current?.attach(sessionId);
      },
      runAction: (task) => {
        const agents = task.agents.filter((agent) => AGENT_LABELS[agent]);
        if (agents.length === 0) return;
        useTerminalUi.getState().reveal();
        if (busy()) return;
        if (agents.length === 1) client.current?.start(agents[0]!, task);
        else setChoice({ ...task, agents });
      },
    });
    return () => useTerminalUi.getState().register(null);
  }, []);

  return { client, state, status, reconnectable, choice, setChoice };
}

/**
 * A direct grid child of `.shell`: sticky positioning breaks under an ancestor that sets
 * `overflow`. Lives in the root layout, so its session survives navigation between views.
 */
export function TerminalSidebar({ terminal }: { terminal: ShellTerminal }) {
  const target = terminal.target;
  const mount = useRef<HTMLDivElement>(null);
  const { client, state, status, reconnectable, choice, setChoice } = useTerminalClient(
    mount,
    target?.digest ?? "",
  );
  const { sessions, end } = useTerminalSessions();
  const ui = useTerminalUi();

  // Escape closes the narrow-window drawer.
  useEffect(() => {
    if (!ui.drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer(ui.setDrawerOpen);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [ui]);

  return (
    <aside
      className="terminal-sidebar"
      id="studio-terminal-panel"
      aria-label="Agent terminal"
      data-terminal-companion={target?.digest}
      data-terminal-state={state}
      data-drawer-open={ui.drawerOpen ? "" : undefined}
    >
      <ResizeHandle />
      <div className="terminal-strip">
        <button
          type="button"
          className="terminal-icon-button"
          id="terminal-expand"
          aria-controls="terminal-body"
          aria-expanded={!ui.collapsed}
          aria-label="Expand the terminal"
          onClick={() => ui.setCollapsed(false)}
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
              aria-expanded={!ui.collapsed}
              aria-label="Collapse the terminal"
              onClick={() => ui.setCollapsed(true)}
            >
              ›
            </button>
            <button
              type="button"
              className="terminal-icon-button"
              id="terminal-drawer-close"
              aria-label="Close the terminal"
              onClick={() => closeDrawer(ui.setDrawerOpen)}
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
            {target ? (
              <StartButtons
                agents={terminal.agents}
                onStart={(agent) => client.current?.start(agent)}
              />
            ) : null}
            <button
              type="button"
              className="button"
              id="terminal-reconnect"
              hidden={!reconnectable}
              onClick={() => client.current?.reconnect()}
            >
              Reconnect
            </button>
          </div>
          <div
            className="terminal-choice"
            id="terminal-action-choice"
            role="group"
            aria-label="Choose an agent"
            hidden={!choice}
          >
            {choice ? (
              <>
                <span>Run {choice.action} with:</span>
                {choice.agents.map((agent) => (
                  <button
                    key={agent}
                    type="button"
                    className="button"
                    onClick={() => {
                      setChoice(null);
                      client.current?.start(agent, choice);
                    }}
                  >
                    {AGENT_LABELS[agent]}
                  </button>
                ))}
                <button type="button" className="button" onClick={() => setChoice(null)}>
                  Cancel
                </button>
              </>
            ) : null}
          </div>
          <p className="terminal-status" id="terminal-status" role="status">
            {status}
          </p>
        </header>
        <div className="terminal-view" id="studio-terminal" ref={mount} />
        <footer className="terminal-sessions-footer">
          <h3 className="terminal-sessions-title">Sessions</h3>
          <SessionList
            sessions={sessions}
            onAttach={(id) => client.current?.attach(id)}
            onEnd={end}
          />
        </footer>
      </div>
    </aside>
  );
}

function StartButtons({
  agents,
  onStart,
}: {
  agents: TerminalAgent[];
  onStart: (agent: TerminalAgent) => void;
}) {
  if (agents.length === 0) {
    return <span className="empty">No agent this companion allows is installed.</span>;
  }
  return agents.map((agent) => (
    <button
      key={agent}
      type="button"
      className="button"
      data-terminal-start={agent}
      onClick={() => onStart(agent)}
    >
      Start {AGENT_LABELS[agent]}
    </button>
  ));
}

/** Running sessions; this tab's own offers no attach. */
function SessionList({
  sessions,
  onAttach,
  onEnd,
}: {
  sessions: TerminalSession[] | undefined;
  onAttach: (id: string) => void;
  onEnd: (id: string) => void;
}) {
  const mine = storedSession();
  return (
    <ul className="terminal-sessions" id="terminal-sessions">
      {sessions && sessions.length === 0 ? (
        <li className="empty">No sessions are running.</li>
      ) : null}
      {sessions?.map((session) => (
        <li key={session.id}>
          <span>
            {session.workset
              ? `Workset ${session.workset.id} (${session.workset.title})`
              : `${session.agent} · ${session.companionPath}`}
            {` · ${viewedFrom(session, mine)} · ${age(session.ageSeconds)}`}
          </span>
          {session.id !== mine ? (
            <button type="button" className="button" onClick={() => onAttach(session.id)}>
              {session.attached ? "Take over" : "Attach"}
            </button>
          ) : null}
          <button type="button" className="button" onClick={() => onEnd(session.id)}>
            End
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Drag to resize; the width is remembered once the drag ends. */
function ResizeHandle() {
  const setWidth = useTerminalUi((state) => state.setWidth);
  const width = useRef(0);
  return (
    <div
      className="terminal-resize"
      id="terminal-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the terminal"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        width.current = window.innerWidth - event.clientX;
        setWidth(width.current, false);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (width.current > 0) setWidth(width.current, true);
      }}
      // A cancelled drag keeps the width it reached, like a finished one.
      onPointerCancel={() => {
        if (width.current > 0) setWidth(width.current, true);
      }}
    />
  );
}

/** Outside `.shell`, so it never takes a grid cell; shown only below the side-by-side breakpoint. */
export function TerminalDrawerButton() {
  const drawerOpen = useTerminalUi((state) => state.drawerOpen);
  const setDrawerOpen = useTerminalUi((state) => state.setDrawerOpen);
  return (
    <button
      type="button"
      className="terminal-drawer-open"
      id="terminal-drawer-open"
      aria-controls="studio-terminal-panel"
      aria-expanded={drawerOpen}
      onClick={() => {
        setDrawerOpen(true);
        requestAnimationFrame(() => document.getElementById("terminal-drawer-close")?.focus());
      }}
    >
      Terminal
    </button>
  );
}
