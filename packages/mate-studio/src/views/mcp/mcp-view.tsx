import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  McpManagerDerived,
  McpManagerState,
  McpManagerView,
  McpVariableStatus,
} from "@uniqbit/mate-core/studio";
import { type ReactNode, type Ref, useRef, useState } from "react";

import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/fields";
import {
  EmptyNote,
  ListCard,
  PAGE_PAD,
  ROW,
  StatusWord,
  ViewLoading,
} from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { mcpManagerQuery, mcpPreviewQuery } from "../../lib/mcp-query";
import { saveMcpManager } from "../../server/mcp-manager";
import { type McpDialog, McpDialogs } from "./mcp-dialogs";
import { type Cell, cellOf, cycleCell, type EntryKind, KIND_WORD, transportOf } from "./mcp-model";

/** The companion's MCP servers, groups and per-audience selection, edited as one unsaved draft. */
export function Mcp({ companion, writable }: { companion: string; writable: boolean }) {
  const query = useQuery(mcpManagerQuery(companion));
  if (query.data)
    return <McpEditor companion={companion} writable={writable} loaded={query.data} />;
  if (!query.isError) return <ViewLoading title="Reading MCP servers…" />;
  return (
    <div className={cn(PAGE_PAD, "text-sm")} role="alert">
      <p className="m-0 text-bad">The MCP servers could not be read.</p>
      <p className="m-0 mt-1 text-muted">{query.error.message}</p>
      <Button className="mt-3" onClick={() => void query.refetch()} disabled={query.isFetching}>
        Retry
      </Button>
    </div>
  );
}

const stateOf = ({ catalog, audiences }: McpManagerState): McpManagerState => ({
  catalog,
  audiences,
});

function McpEditor({
  companion,
  writable,
  loaded,
}: {
  companion: string;
  writable: boolean;
  loaded: McpManagerView;
}) {
  const queryClient = useQueryClient();
  /** Unsaved edits and the read they started from; null while the view shows what was read. */
  const [edit, setEdit] = useState<{ base: McpManagerView; draft: McpManagerState } | null>(null);
  const [conflict, setConflict] = useState<McpManagerView | null>(null);
  const [saved, setSaved] = useState(false);
  const [dialog, setDialog] = useState<{ shown: McpDialog | null; open: boolean }>({
    shown: null,
    open: false,
  });
  const opener = useRef<HTMLElement | null>(null);
  const addServer = useRef<HTMLButtonElement>(null);

  const base = edit?.base ?? loaded;
  const draft = edit?.draft ?? stateOf(loaded);
  const preview = useQuery({
    ...mcpPreviewQuery(companion, draft),
    enabled: edit !== null,
    placeholderData: keepPreviousData,
  });
  const checked = edit ? preview.data : undefined;
  const derived: McpManagerDerived = checked?.ok ? checked : base;
  const invalid = checked?.ok === false ? checked.reason : null;

  const apply = (next: McpManagerState) => {
    setEdit({ base, draft: next });
    setSaved(false);
  };
  const show = (view: McpManagerView) => {
    queryClient.setQueryData(mcpManagerQuery(companion).queryKey, view);
    setEdit(null);
    setConflict(null);
    // The pressed control is gone or disabled once this renders.
    requestAnimationFrame(() => addServer.current?.focus());
  };
  const save = useMutation({
    mutationFn: (token: string) => saveMcpManager({ data: { companion, next: draft, token } }),
    onSuccess: (result) => {
      if (result.kind === "conflict") return setConflict(result.current);
      show(result.view);
      setSaved(true);
    },
  });
  const open = (shown: McpDialog) => (event: { currentTarget: HTMLElement }) => {
    opener.current = event.currentTarget;
    setDialog({ shown, open: true });
  };

  const servers = Object.entries(draft.catalog?.servers ?? {});
  const groups = Object.entries(draft.catalog?.groups ?? {});
  const rowActions = (entry: EntryKind, name: string) => (
    <span className="ml-auto flex flex-none items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={!writable}
        aria-label={`Edit ${name}`}
        onClick={open({ kind: "form", entry, previous: name })}
      >
        Edit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!writable}
        aria-label={`Delete ${name}`}
        onClick={open({ kind: "delete", entry, name })}
      >
        Delete
      </Button>
    </span>
  );
  const addButton = (entry: EntryKind, ref?: Ref<HTMLButtonElement>) => (
    <Button
      ref={ref}
      size="sm"
      disabled={!writable}
      onClick={open({ kind: "form", entry, previous: null })}
    >
      <Icon name="plus" className="size-3.5" />
      Add {KIND_WORD[entry]}
    </Button>
  );

  return (
    <div className={cn(PAGE_PAD, "grid gap-3 pb-8")}>
      <SaveBar
        writable={writable}
        dirty={edit !== null}
        saved={saved}
        pending={save.isPending}
        blocked={invalid !== null || conflict !== null}
        error={invalid ?? (save.isError ? save.error.message || "The save failed." : null)}
        onSave={() => save.mutate(base.token)}
        onDiscard={() => show(conflict ?? loaded)}
      />
      {conflict ? (
        <Conflict
          current={conflict}
          pending={save.isPending}
          onLoad={() => show(conflict)}
          onOverwrite={() => save.mutate(conflict.token)}
        />
      ) : null}
      {servers.length === 0 ? (
        <EmptyNote className="grid justify-items-start gap-3">
          <span>
            This companion declares no MCP servers. Add the first one to give its agents a tool.
          </span>
          {addButton("servers", addServer)}
        </EmptyNote>
      ) : (
        <>
          <ListCard title="Servers" count={servers.length} hint={addButton("servers", addServer)}>
            <ul className="m-0 list-none p-0">
              {servers.map(([name, server]) => (
                <li key={name} className={ROW_LINE} data-mcp-server={name}>
                  <span className="w-40 flex-none truncate font-mono text-sm">{name}</span>
                  <span className="w-12 flex-none text-xs text-muted">{transportOf(server)}</span>
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">
                    {"command" in server
                      ? [server.command, ...(server.args ?? [])].join(" ")
                      : server.url}
                  </code>
                  <Variables statuses={derived.variables[name] ?? []} />
                  {rowActions("servers", name)}
                </li>
              ))}
            </ul>
            <p className="m-0 border-t border-rule-soft px-4 py-2 text-xs text-muted">
              Set and missing describe the environment of this Studio process, which the sessions it
              starts inherit. A variable set only for a session elsewhere shows as missing. Values
              never reach this page.
            </p>
          </ListCard>
          <ListCard title="Groups" count={groups.length} hint={addButton("groups")}>
            {groups.length === 0 ? (
              <p className="m-0 px-4 py-3 text-sm text-muted">
                No groups. A group lets a selection turn several servers on or off at once.
              </p>
            ) : (
              <ul className="m-0 list-none p-0">
                {groups.map(([name, members]) => (
                  <li key={name} className={ROW_LINE}>
                    <span className="w-40 flex-none truncate font-mono text-sm">{name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {members.length > 0 ? members.join(", ") : "no servers"}
                    </span>
                    {rowActions("groups", name)}
                  </li>
                ))}
              </ul>
            )}
          </ListCard>
          <SelectionGrid
            state={draft}
            effective={derived.effective}
            stale={edit !== null && (preview.isPlaceholderData || preview.isPending)}
            writable={writable}
            onChange={apply}
          />
        </>
      )}
      <McpDialogs
        dialog={dialog.shown}
        open={dialog.open}
        companion={companion}
        state={draft}
        onApply={apply}
        onClose={() => setDialog((held) => ({ ...held, open: false }))}
        finalFocus={() => (opener.current?.isConnected ? opener.current : addServer.current)}
      />
    </div>
  );
}

const ROW_LINE = cn(ROW, "py-1.5 hover:bg-transparent");

function Variables({ statuses }: { statuses: McpVariableStatus[] }) {
  if (statuses.length === 0) return null;
  return (
    <span className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1">
      {statuses.map(({ name, set }) => (
        <span key={name} className="inline-flex items-center gap-2 font-mono text-xs">
          {name}
          <StatusWord marker={set ? "done" : "warn"}>{set ? "set" : "missing"}</StatusWord>
        </span>
      ))}
    </span>
  );
}

function SaveBar({
  writable,
  dirty,
  saved,
  pending,
  blocked,
  error,
  onSave,
  onDiscard,
}: {
  writable: boolean;
  dirty: boolean;
  saved: boolean;
  pending: boolean;
  /** The draft cannot be saved as it is: core refuses it, or a conflict waits for an answer. */
  blocked: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!writable) {
    return (
      <p className="m-0 text-sm text-muted" data-mcp-read-only="">
        Studio is read-only. Start it with <code className="font-mono">--writable</code> to change
        MCP servers.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="m-0 mr-auto text-sm text-muted" role="status">
        {dirty ? (
          <span className="inline-flex items-center gap-1.5 text-warn">
            <span className="size-[7px] rounded-full bg-current" aria-hidden="true" />
            Unsaved changes
          </span>
        ) : saved ? (
          "Saved. The changes apply at the next sync or launch."
        ) : (
          "Changes are written to framework.yaml when you save."
        )}
      </p>
      <Button variant="ghost" size="sm" disabled={!dirty || pending} onClick={onDiscard}>
        Discard
      </Button>
      <Button variant="primary" size="sm" disabled={!dirty || pending || blocked} onClick={onSave}>
        {pending ? "Saving…" : "Save"}
      </Button>
      {error ? (
        <p className="m-0 basis-full text-sm text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A stale save: the file's current content beside the kept edits, and the two ways on. */
function Conflict({
  current,
  pending,
  onLoad,
  onOverwrite,
}: {
  current: McpManagerView;
  pending: boolean;
  onLoad: () => void;
  onOverwrite: () => void;
}) {
  const servers = Object.keys(current.catalog?.servers ?? {});
  const groups = Object.keys(current.catalog?.groups ?? {});
  return (
    <section
      className="grid gap-2 rounded-card border border-[color-mix(in_srgb,var(--warn)_40%,var(--border))] bg-warn-soft px-4 py-3 text-sm"
      role="alert"
      aria-label="Save conflict"
      data-mcp-conflict=""
    >
      <h2 className="m-0 text-base font-semibold text-warn">
        framework.yaml changed after this view loaded
      </h2>
      <p className="m-0">Nothing was saved. Your edits are still in the view below.</p>
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
        <ConflictLine label="Servers in the file" names={servers} />
        <ConflictLine label="Groups in the file" names={groups} />
        <ConflictLine label="Base servers in the file" names={current.effective.base} />
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={onLoad}>
          Discard my edits and load the file
        </Button>
        <Button size="sm" variant="danger" disabled={pending} onClick={onOverwrite}>
          Overwrite the file with my edits
        </Button>
      </div>
    </section>
  );
}

function ConflictLine({ label, names }: { label: string; names: string[] }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 font-mono text-xs break-words">
        {names.length > 0 ? names.join(", ") : "none"}
      </dd>
    </>
  );
}

const ON = "border-accent bg-accent-soft font-semibold text-text";
const QUIET = "border-transparent text-muted";

const CELL_VIEW: Record<Cell, { word: string; look: string; icon?: "check" | "close" }> = {
  enabled: { word: "Enabled", look: ON, icon: "check" },
  enable: { word: "Enable", look: ON, icon: "check" },
  disable: {
    word: "Disable",
    look: "border-rule bg-surface font-semibold text-text",
    icon: "close",
  },
  off: { word: "Off", look: QUIET },
  inherit: { word: "Inherit", look: QUIET },
};

const HEAD_CELL =
  "sticky top-0 z-10 border-b border-rule bg-surface px-3 py-2 text-left text-xs font-semibold whitespace-nowrap";
const NAME_CELL =
  "sticky left-0 border-t border-rule-soft bg-page px-4 py-1.5 text-left font-normal";

/**
 * Base and each audience against every server and group. A base cell is enabled or off; an
 * audience cell inherits the base, or enables or disables on top of it. The last row is what
 * core resolves for the column.
 */
function SelectionGrid({
  state,
  effective,
  stale,
  writable,
  onChange,
}: {
  state: McpManagerState;
  effective: McpManagerDerived["effective"];
  /** The effective row still shows an earlier state's answer. */
  stale: boolean;
  writable: boolean;
  onChange: (next: McpManagerState) => void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const rows = (["servers", "groups"] as const).flatMap((kind) =>
    Object.keys(state.catalog?.[kind] ?? {})
      .filter((name) => name.toLowerCase().includes(needle))
      .map((name) => ({ kind, name })),
  );
  const columns: (string | null)[] = [null, ...Object.keys(state.audiences)];
  const cell = (kind: EntryKind, name: string, audience: string | null): ReactNode => {
    const held = cellOf(state, audience, kind, name);
    const { word, look, icon } = CELL_VIEW[held];
    return (
      <td key={audience ?? ""} className="border-t border-rule-soft px-3 py-1">
        <button
          type="button"
          className={cn(
            "inline-flex h-7 min-w-24 items-center gap-1.5 rounded-control border px-2 text-xs transition-colors enabled:hover:border-accent disabled:cursor-not-allowed",
            look,
          )}
          disabled={!writable}
          aria-label={`${name} for ${audience ?? "base"}: ${word}`}
          data-mcp-cell={`${audience ?? "base"}/${name}`}
          data-state={held}
          onClick={() => onChange(cycleCell(state, audience, kind, name))}
        >
          {icon ? <Icon name={icon} className="size-3.5" /> : null}
          {word}
        </button>
      </td>
    );
  };
  return (
    <ListCard
      title="Selection"
      hint={
        <Input
          className="h-7 w-48"
          value={filter}
          placeholder="Filter by name"
          aria-label="Filter servers and groups by name"
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      }
    >
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th scope="col" className={cn(HEAD_CELL, "left-0 z-20 px-4")}>
                Server or group
              </th>
              {columns.map((audience) => (
                <th key={audience ?? ""} scope="col" className={HEAD_CELL}>
                  {audience === null ? "Base" : <span className="font-mono">{audience}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ kind, name }) => (
              <tr key={`${kind}/${name}`}>
                <th scope="row" className={NAME_CELL}>
                  <span className="font-mono text-sm">{name}</span>
                  {kind === "groups" ? (
                    <span className="ml-2 text-xs text-muted">group</span>
                  ) : null}
                </th>
                {columns.map((audience) => cell(kind, name, audience))}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} className="px-4 py-3 text-sm text-muted">
                  No server or group matches the filter.
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr aria-busy={stale}>
              <th scope="row" className={cn(NAME_CELL, "border-rule align-top font-semibold")}>
                Effective servers
              </th>
              {columns.map((audience) => {
                const names = audience === null ? effective.base : effective.audiences[audience];
                return (
                  <td
                    key={audience ?? ""}
                    className={cn(
                      "border-t border-rule px-3 py-2 align-top font-mono text-xs",
                      stale && "opacity-60",
                    )}
                  >
                    {names && names.length > 0 ? (
                      <ul className="m-0 grid list-none gap-0.5 p-0">
                        {names.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="font-sans text-muted">none</span>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="m-0 border-t border-rule-soft px-4 py-2 text-xs text-muted">
        Base applies to every session. An audience column applies on top of it to sessions started
        with <code className="font-mono">MATE_AUDIENCE</code> set to that audience. A sync writes
        the base servers plus the active audience's changes.
      </p>
    </ListCard>
  );
}
