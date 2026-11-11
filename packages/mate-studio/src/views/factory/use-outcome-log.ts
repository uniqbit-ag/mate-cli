import { useEffect, useReducer } from "react";

/** What the run-log stream sends: a replay of the stored log, then core's `LiveEvent`s. */
export type LogEvent =
  | { type: "replay"; log: string; open: { id: string; text: string }[] }
  | { type: "text"; id?: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "tool-done"; name: string; failed: boolean }
  | { type: "log"; text: string }
  | { type: "settled" }
  | { type: "lost" };

/** Who wrote a piece: the agent's text, its tool calls (and failures), or the factory itself. */
export type LogKind = "agent" | "tool" | "failed" | "factory";

export interface LogPiece {
  id?: string;
  kind: LogKind;
  text: string;
}

/** The log as ordered pieces; a streaming block keeps its place while it grows. */
export interface LogState {
  pieces: LogPiece[];
  /** Ids of blocks still streaming, by their index in `pieces`. */
  open: Record<string, number>;
}

export const EMPTY_LOG: LogState = { pieces: [], open: {} };

/** The runner's own notes in the stored log: stage prompts, links, commits, pushes and the like. */
const FACTORY_LINE =
  /^(> |committed: |pushed |published |linked |Returned to automation|no review report |the review report for |\S+ is now at )/;

/**
 * The stored log is plain text; its lines are told apart by the runner's prefixes. Tool calls
 * are not stored, so a replay holds agent text and factory notes only.
 */
export function classifyStored(log: string): LogPiece[] {
  const pieces: LogPiece[] = [];
  for (const line of log.split(/(?<=\n)/)) {
    const kind: LogKind = FACTORY_LINE.test(line) ? "factory" : "agent";
    const last = pieces.at(-1);
    // Blank lines join the piece before them, so the text reads as it was written.
    if (last && (last.kind === kind || line.trim() === "")) last.text += line;
    else pieces.push({ kind, text: line });
  }
  return pieces;
}

/** Streaming blocks by id, tool calls as lines, each piece kept with its kind. */
export function logReducer(state: LogState, event: LogEvent): LogState {
  const append = (kind: LogKind, text: string, id?: string): LogState => {
    const pieces = [...state.pieces, id === undefined ? { kind, text } : { id, kind, text }];
    return {
      pieces,
      open: id === undefined ? state.open : { ...state.open, [id]: pieces.length - 1 },
    };
  };
  const grow = (id: string, text: string): LogState => {
    const at = state.open[id];
    if (at === undefined) return append("agent", text, id);
    const pieces = [...state.pieces];
    pieces[at] = { ...pieces[at]!, text: pieces[at]!.text + text };
    return { ...state, pieces };
  };
  switch (event.type) {
    case "replay": {
      let next: LogState = { pieces: classifyStored(event.log), open: {} };
      for (const block of event.open)
        next = logReducer(next, { type: "text", ...block, delta: block.text });
      return next;
    }
    case "text":
      return event.id === undefined ? append("agent", event.delta) : grow(event.id, event.delta);
    case "text-end": {
      const next = grow(event.id, "\n");
      const { [event.id]: _ended, ...open } = next.open;
      return { ...next, open };
    }
    case "tool":
      return append("tool", `› ${event.name} ${event.summary}\n`);
    case "tool-done":
      return event.failed ? append("failed", `  ${event.name} failed\n`) : state;
    case "log":
      return append("factory", event.text);
    case "lost":
      return append("factory", "\nThis view fell behind the run; close and reopen the Outcome.\n");
    case "settled":
      return state;
  }
}

/**
 * Follows one Outcome's run log for as long as its dialog is open; `null` follows none. The stream keeps going
 * across stages; when a stage ends the board's own update shows the new state in place.
 */
export function useOutcomeLog(url: string | null): { pieces: LogPiece[]; ended: boolean } {
  const [state, dispatch] = useReducer(
    (current: LogState & { ended: boolean }, event: LogEvent | { type: "reset" }) =>
      event.type === "reset"
        ? { ...EMPTY_LOG, ended: false }
        : { ...logReducer(current, event), ended: current.ended || event.type === "lost" },
    { ...EMPTY_LOG, ended: false },
  );
  useEffect(() => {
    dispatch({ type: "reset" });
    if (!url || typeof EventSource === "undefined") return;
    const source = new EventSource(url);
    source.addEventListener("message", (message) => {
      try {
        dispatch(JSON.parse(message.data) as LogEvent);
      } catch {
        /* a malformed event is skipped, never shown */
      }
    });
    return () => source.close();
  }, [url]);
  return { pieces: state.pieces, ended: state.ended };
}
