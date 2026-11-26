import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MCP_MANAGER_HEADER_PREFIXES, type McpManagerState } from "@uniqbit/mate-core/studio";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";

import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input, Textarea } from "../../components/ui/fields";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Pills } from "../../components/view-parts";
import { mcpPreviewQuery } from "../../lib/mcp-query";
import {
  type EntryKind,
  type HeaderRow,
  nameTaken,
  referenceText,
  type ServerForm,
  serverForm,
  serverOf,
  type Transport,
  TRANSPORTS,
  withEntry,
  withoutEntry,
} from "./mcp-model";

export type McpDialog =
  | { kind: "server"; previous: string | null }
  | { kind: "group"; previous: string | null }
  | { kind: "delete"; entry: EntryKind; name: string };

const KIND_WORD: Record<EntryKind, string> = { servers: "server", groups: "group" };

const NO_PREFIX = "none";
const PREFIXES = [
  { value: NO_PREFIX, label: "No prefix" },
  ...MCP_MANAGER_HEADER_PREFIXES.map((prefix) => ({ value: prefix, label: prefix.trim() })),
];

interface BodyProps {
  companion: string;
  state: McpManagerState;
  onApply: (next: McpManagerState) => void;
  onClose: () => void;
}

/**
 * One dialog for the server form, the group form and the delete confirmation. `dialog` stays
 * set while it closes, so its content is still there for the closing transition.
 */
export function McpDialogs({
  dialog,
  open,
  finalFocus,
  ...body
}: BodyProps & {
  dialog: McpDialog | null;
  open: boolean;
  /** Where focus lands on close; the opening control may be gone by then. */
  finalFocus: () => HTMLElement | boolean | null;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) body.onClose();
      }}
    >
      <DialogContent
        className="grid max-h-[80vh] w-[min(520px,calc(100vw-32px))] gap-4 overflow-y-auto p-5"
        finalFocus={finalFocus}
      >
        {dialog?.kind === "server" ? <ServerBody previous={dialog.previous} {...body} /> : null}
        {dialog?.kind === "group" ? <GroupBody previous={dialog.previous} {...body} /> : null}
        {dialog?.kind === "delete" ? (
          <DeleteBody entry={dialog.entry} name={dialog.name} {...body} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Applies an edit only once core accepts the resulting state; its refusal is shown instead. */
function useCheckedApply({ companion, onApply, onClose }: BodyProps) {
  const queryClient = useQueryClient();
  const check = useMutation({
    mutationFn: (next: McpManagerState) => queryClient.fetchQuery(mcpPreviewQuery(companion, next)),
    onSuccess: (preview, next) => {
      if (!preview.ok) return;
      onApply(next);
      onClose();
    },
  });
  const refusal = check.isError
    ? check.error.message || "The entry could not be checked."
    : check.data?.ok === false
      ? check.data.reason
      : null;
  return { apply: check.mutate, pending: check.isPending, refusal, reset: check.reset };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span>{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

function FormActions({ pending, action }: { pending: boolean; action: string }) {
  return (
    <div className="flex justify-end gap-2">
      <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Checking…" : action}
      </Button>
    </div>
  );
}

function Refusal({ children }: { children: ReactNode }) {
  return children ? (
    <p className="m-0 text-sm text-bad" role="alert">
      {children}
    </p>
  ) : null;
}

function ServerBody({ previous, ...body }: BodyProps & { previous: string | null }) {
  const { state } = body;
  const [form, setForm] = useState(() =>
    serverForm(previous ?? "", previous ? state.catalog?.servers?.[previous] : undefined),
  );
  const [taken, setTaken] = useState<string | null>(null);
  const checked = useCheckedApply(body);
  const set = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) =>
    setForm((held) => ({ ...held, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (nameTaken(state, "servers", previous, name)) {
      checked.reset();
      return setTaken(name);
    }
    setTaken(null);
    checked.apply(withEntry(state, "servers", previous, name, serverOf(form)));
  };
  return (
    <form className="grid gap-3.5" onSubmit={submit}>
      <div className="grid gap-1.5">
        <DialogTitle className="text-md">
          {previous ? `Edit ${previous}` : "Add a server"}
        </DialogTitle>
        <DialogDescription>
          Variables are given by name only. Mate never stores or shows a value.
        </DialogDescription>
      </div>
      <Field label="Name" hint="Lowercase letters, digits and hyphens.">
        <Input
          className="font-mono"
          value={form.name}
          placeholder="acme-docs"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set("name", event.currentTarget.value)}
        />
      </Field>
      <div className="grid gap-1.5 text-sm">
        <span>Transport</span>
        <Pills
          label="Transport"
          options={TRANSPORTS.map((transport) => ({ value: transport, label: transport }))}
          value={form.transport}
          onChange={(transport: Transport) => set("transport", transport)}
        />
      </div>
      {form.transport === "stdio" ? (
        <>
          <Field label="Command">
            <Input
              className="font-mono"
              value={form.command}
              placeholder="acme-docs-mcp"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set("command", event.currentTarget.value)}
            />
          </Field>
          <Field label="Arguments" hint="One per line.">
            <Textarea
              className="min-h-16 font-mono"
              value={form.args}
              spellCheck={false}
              onChange={(event) => set("args", event.currentTarget.value)}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <Input
              className="font-mono"
              value={form.url}
              placeholder="https://acme.test/mcp"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set("url", event.currentTarget.value)}
            />
          </Field>
          <HeaderRows rows={form.headers} onChange={(headers) => set("headers", headers)} />
        </>
      )}
      <Field
        label="Environment variable names"
        hint="One name per line, such as ACME_TOKEN. Set the values where Studio and your agents run."
      >
        <Textarea
          className="min-h-16 font-mono"
          value={form.env}
          spellCheck={false}
          onChange={(event) => set("env", event.currentTarget.value)}
        />
      </Field>
      <Refusal>{taken ? `A server named ${taken} already exists.` : checked.refusal}</Refusal>
      <FormActions pending={checked.pending} action={previous ? "Apply" : "Add server"} />
    </form>
  );
}

/** Each header is a name, an optional scheme prefix and the one variable holding its value. */
function HeaderRows({
  rows,
  onChange,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  const add = useRef<HTMLButtonElement>(null);
  const id = useId();
  const change = (index: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="m-0 grid gap-1.5 border-0 p-0 text-sm">
      <legend className="mb-1.5 p-0">Headers</legend>
      {rows.map((row, index) => (
        // Rows have no identity of their own, and one is only ever removed with its own button.
        // oxlint-disable-next-line react/no-array-index-key
        <div key={`${id}-${index}`} className="flex items-center gap-1.5">
          <Input
            className="min-w-0 flex-1 font-mono"
            value={row.header}
            placeholder="Authorization"
            aria-label={`Header ${index + 1} name`}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => change(index, { header: event.currentTarget.value })}
          />
          <Select
            items={PREFIXES}
            value={row.prefix || NO_PREFIX}
            onValueChange={(next) => {
              if (next !== null) change(index, { prefix: next === NO_PREFIX ? "" : next });
            }}
          >
            <SelectTrigger className="w-32 flex-none" aria-label={`Header ${index + 1} prefix`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PREFIXES.map((prefix) => (
                <SelectItem key={prefix.value} value={prefix.value}>
                  {prefix.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="min-w-0 flex-1 font-mono"
            value={row.variable}
            placeholder="ACME_KEY"
            aria-label={`Header ${index + 1} variable name`}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => change(index, { variable: event.currentTarget.value })}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove header ${index + 1}`}
            onClick={() => {
              onChange(rows.filter((_, at) => at !== index));
              add.current?.focus();
            }}
          >
            <Icon name="close" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          ref={add}
          size="sm"
          onClick={() => onChange([...rows, { header: "", prefix: "", variable: "" }])}
        >
          <Icon name="plus" className="size-3.5" />
          Add header
        </Button>
      </div>
      <span className="text-xs text-muted">
        A header's value is the prefix followed by the named variable.
      </span>
    </fieldset>
  );
}

function GroupBody({ previous, ...body }: BodyProps & { previous: string | null }) {
  const { state } = body;
  const servers = Object.keys(state.catalog?.servers ?? {});
  const [name, setName] = useState(previous ?? "");
  const [members, setMembers] = useState<readonly string[]>(
    () => (previous ? state.catalog?.groups?.[previous] : undefined) ?? [],
  );
  const [taken, setTaken] = useState<string | null>(null);
  const checked = useCheckedApply(body);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    if (nameTaken(state, "groups", previous, next)) {
      checked.reset();
      return setTaken(next);
    }
    setTaken(null);
    // Catalog order, whatever order the boxes were ticked in.
    const ordered = servers.filter((server) => members.includes(server));
    checked.apply(withEntry(state, "groups", previous, next, ordered));
  };
  return (
    <form className="grid gap-3.5" onSubmit={submit}>
      <div className="grid gap-1.5">
        <DialogTitle className="text-md">
          {previous ? `Edit ${previous}` : "Add a group"}
        </DialogTitle>
        <DialogDescription>
          A group lets a selection turn several servers on or off at once.
        </DialogDescription>
      </div>
      <Field label="Name" hint="Lowercase letters, digits and hyphens.">
        <Input
          className="font-mono"
          value={name}
          placeholder="acme-data"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      <fieldset className="m-0 grid gap-1 border-0 p-0 text-sm">
        <legend className="mb-1.5 p-0">Servers</legend>
        {servers.map((server) => (
          <label key={server} className="inline-flex items-center gap-2 font-mono text-xs">
            <input
              type="checkbox"
              checked={members.includes(server)}
              onChange={(event) =>
                setMembers(
                  event.currentTarget.checked
                    ? [...members, server]
                    : members.filter((member) => member !== server),
                )
              }
            />
            {server}
          </label>
        ))}
      </fieldset>
      <Refusal>{taken ? `A group named ${taken} already exists.` : checked.refusal}</Refusal>
      <FormActions pending={checked.pending} action={previous ? "Apply" : "Add group"} />
    </form>
  );
}

function DeleteBody({
  entry,
  name,
  state,
  onApply,
  onClose,
}: BodyProps & { entry: EntryKind; name: string }) {
  const references = referenceText(state, entry, name);
  return (
    <>
      <div className="grid gap-1.5">
        <DialogTitle className="text-md">
          Delete {KIND_WORD[entry]} <span className="font-mono">{name}</span>?
        </DialogTitle>
        <DialogDescription>
          {references
            ? `It is used by ${references}. Deleting it removes it there too.`
            : "No group or selection uses it."}{" "}
          Nothing is written until you save.
        </DialogDescription>
      </div>
      <div className="flex justify-end gap-2">
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button
          variant="danger"
          onClick={() => {
            onApply(withoutEntry(state, entry, name));
            onClose();
          }}
        >
          <Icon name="trash" />
          Delete {KIND_WORD[entry]}
        </Button>
      </div>
    </>
  );
}
