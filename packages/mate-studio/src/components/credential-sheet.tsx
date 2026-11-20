import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CredentialKind, CredentialStatus } from "@uniqbit/mate-core/studio";
import { type FormEvent, type ReactNode, useState } from "react";

import { Sheet, SheetClose, SheetContent, SheetTitle } from "./ui/sheet";

/** One tab's form: what it asks for, and how to get it. */
export interface CredentialTab {
  kind: CredentialKind;
  tab: string;
  label: string;
  hint: ReactNode;
}

/** The subscription tab's steps, shared by every sheet. */
export const SETUP_TOKEN_STEPS = (
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
);

/** Reads one field and empties the form, so the value lives only in this request. */
function takeField(event: FormEvent<HTMLFormElement>, name: string): string {
  event.preventDefault();
  const form = event.currentTarget;
  const value = new FormData(form).get(name);
  form.reset();
  return typeof value === "string" ? value : "";
}

function SecretForm({
  tab: { kind, label, hint },
  set,
  onSaved,
}: {
  tab: CredentialTab;
  set: (kind: CredentialKind, value: string) => Promise<CredentialStatus>;
  onSaved: (status: CredentialStatus) => void;
}) {
  const save = useMutation({
    mutationFn: (value: string) => set(kind, value),
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

export interface CredentialSheetProps {
  title: string;
  /** The status query; only the status is cached, never a value. */
  query: { queryKey: readonly unknown[]; queryFn: () => Promise<CredentialStatus> };
  set: (kind: CredentialKind, value: string) => Promise<CredentialStatus>;
  clear: () => Promise<CredentialStatus>;
  /** The first tab opens first. */
  tabs: readonly CredentialTab[];
  statusText: (status: CredentialStatus | undefined) => string;
  savedText: string;
  onClose: () => void;
}

/** A sheet sliding over the page that sets one Claude credential, by API key or subscription token. */
export function CredentialSheet({
  title,
  query,
  set,
  clear: clearCredential,
  tabs,
  statusText,
  savedText,
  onClose,
}: CredentialSheetProps) {
  const queryClient = useQueryClient();
  const status = useQuery(query);
  const [tab, setTab] = useState<CredentialKind>(tabs[0]!.kind);
  const [saved, setSaved] = useState(false);
  const form = tabs.find((entry) => entry.kind === tab)!;
  const onSaved = (next: CredentialStatus) => {
    queryClient.setQueryData(query.queryKey, next);
    setSaved(true);
  };
  const clear = useMutation({
    mutationFn: clearCredential,
    onSuccess: (next) => {
      queryClient.setQueryData(query.queryKey, next);
      setSaved(false);
    },
  });
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="agents-dialog"
        aria-labelledby="agents-title"
        initialFocus={() =>
          document.querySelector<HTMLElement>(".agents-dialog .outcome-dialog-close")
        }
      >
        <header className="outcome-dialog-head">
          <div className="outcome-dialog-heading">
            <SheetTitle id="agents-title">{title}</SheetTitle>
            <p className="outcome-dialog-state" data-agents-status="">
              {status.error ? status.error.message : statusText(status.data)}
            </p>
          </div>
          <SheetClose className="outcome-dialog-close" aria-keyshortcuts="Escape">
            Close <kbd>Esc</kbd>
          </SheetClose>
        </header>
        <div className="agents-dialog-body">
          {tabs.length > 1 ? (
            <div role="tablist" aria-label="How to sign in" className="agents-tabs">
              {tabs.map((entry) => (
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
          ) : null}
          {tabs.length > 1 ? (
            <div role="tabpanel" id="agents-panel" aria-labelledby={`agents-tab-${tab}`}>
              <SecretForm key={form.kind} tab={form} set={set} onSaved={onSaved} />
            </div>
          ) : (
            <SecretForm key={form.kind} tab={form} set={set} onSaved={onSaved} />
          )}
          {saved ? (
            <p className="note" role="status">
              {savedText}
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
      </SheetContent>
    </Sheet>
  );
}
