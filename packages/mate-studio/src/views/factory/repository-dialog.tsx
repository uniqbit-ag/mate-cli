import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RepositoryAddInput, RepositoryAddResult } from "@uniqbit/mate-core/studio";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/fields";
import { cn } from "../../lib/cn";
import { afterFactoryAction } from "../../lib/studio-queries";
import { addRepository, removeRepository } from "../../server/factory";
import { GitTokenForm } from "./git-token-form";

type Mode = "url" | "path";

const MODES: { mode: Mode; label: string; field: string; placeholder: string; hint: string }[] = [
  {
    mode: "url",
    label: "Git URL",
    field: "Git URL of the repository",
    placeholder: "https://git.acme.test/acme/web.git",
    hint: "The factory checks the remote answers before it is listed. A private repository asks for a Git token.",
  },
  {
    mode: "path",
    label: "Local path",
    field: "Absolute path of a checkout",
    placeholder: "/home/dev/acme-web",
    hint: "Only the checkout's origin URL is listed. The factory clones from that URL, so commits not pushed there are not seen.",
  },
];

/** Adds a Working Repository to the companion's list by Git URL or from a local checkout, and removes listed ones. */
export function RepositoryDialog({
  open,
  companion,
  listed,
  onClose,
  onAdded,
}: {
  open: boolean;
  companion: string;
  /** `org/repository` of the entries the list holds: the only ones Studio can remove. */
  listed: string[];
  onClose: () => void;
  /** Runs with the repository to select, whether it was added or already offered. */
  onAdded: (identity: string) => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("url");
  const [value, setValue] = useState("");
  const [refusal, setRefusal] = useState<Extract<RepositoryAddResult, { ok: false }> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const form = MODES.find((entry) => entry.mode === mode)!;
  const input = (): RepositoryAddInput =>
    mode === "url" ? { kind: "url", url: value } : { kind: "path", path: value };
  const add = useMutation({
    mutationFn: () => addRepository({ data: { companion, input: input() } }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setRefusal(result);
        return;
      }
      await afterFactoryAction(queryClient, companion);
      setValue("");
      setNote(result.warning ?? null);
      onAdded(result.identity);
      if (!result.warning) onClose();
    },
  });
  const remove = useMutation({
    mutationFn: (identity: string) => removeRepository({ data: { companion, identity } }),
    onSuccess: async (result) => {
      if (result.ok) await afterFactoryAction(queryClient, companion);
      else setRefusal(result);
    },
  });
  function reset() {
    setValue("");
    setRefusal(null);
    setNote(null);
    add.reset();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        reset();
        onClose();
      }}
    >
      <DialogContent className="grid w-[min(520px,calc(100vw-32px))] gap-4 p-5">
        <div className="grid gap-1.5">
          <DialogTitle className="text-md">Add a repository</DialogTitle>
          <DialogDescription>{form.hint}</DialogDescription>
        </div>
        <div role="tablist" aria-label="How to add" className="flex gap-1.5">
          {MODES.map((entry) => (
            <button
              key={entry.mode}
              type="button"
              role="tab"
              aria-selected={mode === entry.mode}
              className={cn(
                "h-7 rounded-full border border-rule bg-transparent px-3 text-sm text-muted",
                mode === entry.mode && "border-accent bg-accent-soft text-text",
              )}
              onClick={() => {
                setMode(entry.mode);
                reset();
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <form
          className="grid gap-3"
          data-add-repository-form=""
          onSubmit={(event) => {
            event.preventDefault();
            setRefusal(null);
            setNote(null);
            add.mutate();
          }}
        >
          <label className="grid gap-1.5 text-sm">
            <span>{form.field}</span>
            <Input
              value={value}
              placeholder={form.placeholder}
              autoComplete="off"
              spellCheck={false}
              required
              onChange={(event) => setValue(event.currentTarget.value)}
              aria-label={form.field}
            />
          </label>
          {refusal ? (
            <p className="m-0 text-sm text-bad" role="alert">
              {refusal.reason}
            </p>
          ) : null}
          {add.isError ? (
            <p className="m-0 text-sm text-bad" role="alert">
              {add.error instanceof Error ? add.error.message : "The repository was not added."}
            </p>
          ) : null}
          {note ? (
            <p className="m-0 text-sm text-muted" role="status">
              Added. {note}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <DialogClose render={<Button variant="ghost" type="button" />}>Close</DialogClose>
            <Button type="submit" disabled={add.isPending || value.trim() === ""}>
              {add.isPending ? "Checking…" : "Add repository"}
            </Button>
          </div>
        </form>
        {refusal && "tokenKey" in refusal && refusal.tokenKey ? (
          <div className="grid gap-2 border-t border-rule pt-3" data-add-repository-token="">
            <p className="m-0 text-sm text-muted">
              Set a Git token for this host, then add the repository again.
            </p>
            <GitTokenForm
              defaultKey={refusal.tokenKey}
              onSaved={() => {
                setRefusal(null);
                add.mutate();
              }}
            />
          </div>
        ) : null}
        {listed.length > 0 ? (
          <ul
            className="m-0 grid list-none gap-1.5 border-t border-rule p-0 pt-3"
            data-listed-repositories=""
          >
            {listed.map((identity) => (
              <li key={identity} className="flex items-center justify-between gap-2 text-sm">
                <span className="font-mono">{identity}</span>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(identity)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
