import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CredentialKind, CredentialStatus } from "@uniqbit/mate-core/studio";
import { type FormEvent, type ReactNode, useState } from "react";

import {
  agentCredentialKey,
  agentCredentialQuery,
  clearAgentCredential,
  setAgentCredential,
} from "../../lib/agent-credential";
import { useModalDialog } from "./use-modal-dialog";

/** Each tab's form: what it asks for, and how to get it. */
const TABS: { kind: CredentialKind; tab: string; label: string; hint: ReactNode }[] = [
  {
    kind: "subscription",
    tab: "Claude subscription",
    label: "Subscription token",
    hint: (
      <ol className="note agents-steps">
        <li>
          In a terminal on your own machine, run <code>claude setup-token</code>.
        </li>
        <li>Sign in with your Claude account in the browser it opens.</li>
        <li>
          Paste the token it prints below. It starts with <code>sk-ant-oat</code> and is valid for a
          year.
        </li>
      </ol>
    ),
  },
  {
    kind: "api-key",
    tab: "API key",
    label: "Anthropic API key",
    hint: <p className="note">Agents bill this key. It starts with sk-ant-api.</p>,
  },
];

const KIND_LABELS: Record<CredentialKind, string> = {
  subscription: "Claude subscription token",
  "api-key": "Anthropic API key",
};

function statusText(status: CredentialStatus | undefined): string {
  if (!status) return "Checking…";
  if (!status.kind) return "No credential set. Worksets cannot start agents until one is.";
  const source =
    status.source === "studio"
      ? `set in Studio${status.setAt ? ` on ${new Date(status.setAt).toLocaleString()}` : ""}`
      : "supplied at startup";
  return `${KIND_LABELS[status.kind]}, ${source}.`;
}

/** Reads one field and empties the form, so the value lives only in this request. */
function takeField(event: FormEvent<HTMLFormElement>, name: string): string {
  event.preventDefault();
  const form = event.currentTarget;
  const value = new FormData(form).get(name);
  form.reset();
  return typeof value === "string" ? value : "";
}

function SecretForm({
  kind,
  label,
  hint,
  onSaved,
}: {
  kind: CredentialKind;
  label: string;
  hint: ReactNode;
  onSaved: (status: CredentialStatus) => void;
}) {
  const save = useMutation({
    mutationFn: (value: string) => setAgentCredential(kind, value),
    onSuccess: onSaved,
  });
  return (
    <form
      className="factory-sheet"
      data-agents-form={kind}
      onSubmit={(event) => save.mutate(takeField(event, "value"))}
    >
      {hint}
      <label className="agents-field">
        <span>{label}</span>
        <input type="password" name="value" autoComplete="off" spellCheck={false} required />
      </label>
      <div className="factory-sheet-actions">
        <button type="submit" disabled={save.isPending}>
          Save
        </button>
      </div>
      {save.error ? (
        <p className="factory-problems" role="alert">
          {save.error.message}
        </p>
      ) : null}
    </form>
  );
}

/** The Agents panel: sets the one Claude credential the factory's Workset agents use. */
export function AgentsDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const status = useQuery(agentCredentialQuery());
  const [tab, setTab] = useState<CredentialKind>("subscription");
  const [saved, setSaved] = useState(false);
  const form = TABS.find((entry) => entry.kind === tab)!;
  const onSaved = (next: CredentialStatus) => {
    queryClient.setQueryData(agentCredentialKey, next);
    setSaved(true);
  };
  const clear = useMutation({
    mutationFn: clearAgentCredential,
    onSuccess: (next) => {
      queryClient.setQueryData(agentCredentialKey, next);
      setSaved(false);
    },
  });
  const ref = useModalDialog(onClose, (dialog) => dialog.showModal?.());
  return (
    <dialog ref={ref} className="outcome-dialog agents-dialog" aria-labelledby="agents-title">
      <header className="outcome-dialog-head">
        <div className="outcome-dialog-heading">
          <h2 id="agents-title">Workset agents</h2>
          <p className="outcome-dialog-state" data-agents-status="">
            {status.error ? status.error.message : statusText(status.data)}
          </p>
        </div>
        <form method="dialog">
          <button type="submit" className="outcome-dialog-close" aria-keyshortcuts="Escape">
            Close <kbd>Esc</kbd>
          </button>
        </form>
      </header>
      <div className="agents-dialog-body">
        <div role="tablist" aria-label="How to sign in" className="agents-tabs">
          {TABS.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              role="tab"
              id={`agents-tab-${entry.kind}`}
              aria-controls="agents-panel"
              aria-selected={tab === entry.kind}
              onClick={() => {
                setTab(entry.kind);
                setSaved(false);
              }}
            >
              {entry.tab}
            </button>
          ))}
        </div>
        <div role="tabpanel" id="agents-panel" aria-labelledby={`agents-tab-${tab}`}>
          <SecretForm
            key={form.kind}
            kind={form.kind}
            label={form.label}
            hint={form.hint}
            onSaved={onSaved}
          />
        </div>
        {saved ? (
          <p className="note" role="status">
            Saved. The next agent start uses it.
          </p>
        ) : null}
        {status.data?.source === "studio" ? (
          <div className="factory-sheet-actions agents-clear">
            <button type="button" onClick={() => clear.mutate()} disabled={clear.isPending}>
              Remove the credential set in Studio
            </button>
            {clear.error ? (
              <p className="factory-problems" role="alert">
                {clear.error.message}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
