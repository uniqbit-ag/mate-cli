import {
  MCP_MANAGER_TRANSPORTS,
  type McpManagerSelection,
  type McpManagerServer,
  type McpManagerState,
  type McpManagerTransport,
  parseHeaderRef,
} from "@uniqbit/mate-core/studio";

/** The catalog's two kinds of entry, named as selections list them. */
export type EntryKind = "servers" | "groups";

export const KIND_WORD: Record<EntryKind, string> = { servers: "server", groups: "group" };

/** A grid cell: the base column has the first two states, an audience column the other three. */
export type Cell = "enabled" | "off" | "inherit" | "enable" | "disable";

const NEXT_CELL: Record<Cell, Cell> = {
  enabled: "off",
  off: "enabled",
  inherit: "enable",
  enable: "disable",
  disable: "inherit",
};

const names = (selection: McpManagerSelection | undefined, kind: EntryKind): string[] =>
  selection?.[kind] ?? [];

/** `audience` null is the base column. */
export function cellOf(
  state: McpManagerState,
  audience: string | null,
  kind: EntryKind,
  name: string,
): Cell {
  if (audience === null) {
    return names(state.catalog?.enabled, kind).includes(name) ? "enabled" : "off";
  }
  const selection = state.audiences[audience];
  if (names(selection?.enable, kind).includes(name)) return "enable";
  if (names(selection?.disable, kind).includes(name)) return "disable";
  return "inherit";
}

function listed(
  selection: McpManagerSelection | undefined,
  kind: EntryKind,
  name: string,
  on: boolean,
): McpManagerSelection {
  const others = names(selection, kind).filter((entry) => entry !== name);
  return { ...selection, [kind]: on ? [...others, name] : others };
}

/** The state after one click on a cell. */
export function cycleCell(
  state: McpManagerState,
  audience: string | null,
  kind: EntryKind,
  name: string,
): McpManagerState {
  const cell = NEXT_CELL[cellOf(state, audience, kind, name)];
  if (audience === null) {
    const enabled = listed(state.catalog?.enabled, kind, name, cell === "enabled");
    return { ...state, catalog: { ...state.catalog, enabled } };
  }
  const selection = state.audiences[audience];
  return {
    ...state,
    audiences: {
      ...state.audiences,
      [audience]: {
        enable: listed(selection?.enable, kind, name, cell === "enable"),
        disable: listed(selection?.disable, kind, name, cell === "disable"),
      },
    },
  };
}

interface References {
  /** Groups holding a server; always empty for a group. */
  groups: string[];
  base: boolean;
  audiences: string[];
}

/** Where a server or group is named, so a delete can say what it also changes. */
function referencesOf(state: McpManagerState, kind: EntryKind, name: string): References {
  const groups = kind === "servers" ? Object.entries(state.catalog?.groups ?? {}) : [];
  return {
    groups: groups.filter(([, members]) => members.includes(name)).map(([group]) => group),
    base: cellOf(state, null, kind, name) === "enabled",
    audiences: Object.keys(state.audiences).filter(
      (audience) => cellOf(state, audience, kind, name) !== "inherit",
    ),
  };
}

/** "a, b and c". */
function inWords(parts: string[]): string {
  return parts.length < 2
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What else a delete changes, in words; null when nothing names the entry. */
export function referenceText(
  state: McpManagerState,
  kind: EntryKind,
  name: string,
): string | null {
  const { groups, base, audiences } = referencesOf(state, kind, name);
  const parts = [
    ...(groups.length > 0
      ? [`${groups.length === 1 ? "group" : "groups"} ${inWords(groups)}`]
      : []),
    ...(base ? ["the base selection"] : []),
    ...(audiences.length > 0
      ? [`${audiences.length === 1 ? "audience" : "audiences"} ${inWords(audiences)}`]
      : []),
  ];
  return parts.length > 0 ? inWords(parts) : null;
}

/** Every reference to `name` renamed to `to`, or dropped when `to` is null. */
function rewritten(
  state: McpManagerState,
  kind: EntryKind,
  name: string,
  to: string | null,
): McpManagerState {
  const list = (entries: string[]) =>
    entries.flatMap((entry) => (entry === name ? (to ?? []) : entry));
  const selection = (held: McpManagerSelection | undefined) =>
    held?.[kind] ? { ...held, [kind]: list(held[kind]) } : held;
  const groups = state.catalog?.groups;
  return {
    catalog: {
      ...state.catalog,
      groups:
        kind === "servers" && groups
          ? Object.fromEntries(
              Object.entries(groups).map(([group, members]) => [group, list(members)]),
            )
          : groups,
      enabled: selection(state.catalog?.enabled),
    },
    audiences: Object.fromEntries(
      Object.entries(state.audiences).map(([audience, held]) => [
        audience,
        { enable: selection(held.enable), disable: selection(held.disable) },
      ]),
    ),
  };
}

/** The state without the entry and without any reference to it. */
export function withoutEntry(state: McpManagerState, kind: EntryKind, name: string) {
  const next = rewritten(state, kind, name, null);
  const { [name]: _removed, ...kept } = next.catalog?.[kind] ?? {};
  return { ...next, catalog: { ...next.catalog, [kind]: kept } };
}

/**
 * The state with the entry added, or replacing `previous` in its place; a changed name moves
 * every reference to the new one.
 */
export function withEntry<K extends EntryKind>(
  state: McpManagerState,
  kind: K,
  previous: string | null,
  name: string,
  value: K extends "servers" ? McpManagerServer : string[],
): McpManagerState {
  const next =
    previous !== null && previous !== name ? rewritten(state, kind, previous, name) : state;
  const entries: [string, unknown][] = Object.entries(next.catalog?.[kind] ?? {});
  const at = entries.findIndex(([entry]) => entry === previous);
  if (at === -1) entries.push([name, value]);
  else entries[at] = [name, value];
  return { ...next, catalog: { ...next.catalog, [kind]: Object.fromEntries(entries) } };
}

/** Whether another entry of `kind` already holds `name`; core checks the other kind. */
export function nameTaken(
  state: McpManagerState,
  kind: EntryKind,
  previous: string | null,
  name: string,
): boolean {
  return name !== previous && Object.hasOwn(state.catalog?.[kind] ?? {}, name);
}

export type Transport = "stdio" | McpManagerTransport;

export const TRANSPORTS: readonly Transport[] = ["stdio", ...MCP_MANAGER_TRANSPORTS];

export function transportOf(server: McpManagerServer): Transport {
  return "command" in server ? "stdio" : (server.transport ?? "http");
}

/** One header: its name, a scheme prefix or none, and the one variable it reads. */
export interface HeaderRow {
  header: string;
  prefix: string;
  variable: string;
}

/** What the server form holds; lists are one entry per line. */
export interface ServerForm {
  name: string;
  transport: Transport;
  command: string;
  args: string;
  url: string;
  env: string;
  headers: HeaderRow[];
}

function headerRows(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([header, value]) => ({
    header,
    // The catalog was validated on read, so every value parses.
    ...(parseHeaderRef(value) ?? { prefix: "", variable: "" }),
  }));
}

export function serverForm(name = "", server?: McpManagerServer): ServerForm {
  const stdio = server && "command" in server ? server : undefined;
  const remote = server && "url" in server ? server : undefined;
  return {
    name,
    transport: server ? transportOf(server) : "stdio",
    command: stdio?.command ?? "",
    args: (stdio?.args ?? []).join("\n"),
    url: remote?.url ?? "",
    env: (server?.env ?? []).join("\n"),
    headers: headerRows(remote?.headers),
  };
}

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** The server a form declares, without empty lists; core validates it. */
export function serverOf(form: ServerForm): McpManagerServer {
  const env = lines(form.env);
  const shared = env.length > 0 ? { env } : {};
  if (form.transport === "stdio") {
    const args = lines(form.args);
    return { command: form.command.trim(), ...(args.length > 0 ? { args } : {}), ...shared };
  }
  const headers = form.headers.filter((row) => row.header.trim() || row.variable.trim());
  return {
    url: form.url.trim(),
    ...(form.transport === "sse" ? { transport: "sse" as const } : {}),
    ...(headers.length > 0
      ? {
          headers: Object.fromEntries(
            headers.map((row) => [row.header.trim(), `${row.prefix}\${${row.variable.trim()}}`]),
          ),
        }
      : {}),
    ...shared,
  };
}
