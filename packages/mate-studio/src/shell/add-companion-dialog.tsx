import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanionAddInput, CompanionAddResult } from "@uniqbit/mate-core/studio";
import { useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/fields";
import { cn } from "../lib/cn";
import { addCompanion } from "../server/companions";
import { GitTokenForm } from "../views/factory/git-token-form";

type Mode = "url" | "path";

const MODES: { mode: Mode; label: string; field: string; placeholder: string; hint: string }[] = [
  {
    mode: "url",
    label: "Git URL",
    field: "Git URL of the companion",
    placeholder: "https://git.acme.test/acme/companion.git",
    hint: "The factory clones it into its companions directory. A private repository asks for a Git token.",
  },
  {
    mode: "path",
    label: "Local path",
    field: "Absolute path of the companion's folder",
    placeholder: "/srv/acme-companion",
    hint: "Registered where it is, on the machine Studio runs on. Nothing is copied.",
  },
];

/** Adds a companion by Git URL or local path; opens the token form when a private clone is refused. */
export function AddCompanionDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (digest: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("url");
  const [value, setValue] = useState("");
  const [refusal, setRefusal] = useState<Extract<CompanionAddResult, { ok: false }> | null>(null);
  const queryClient = useQueryClient();
  const form = MODES.find((entry) => entry.mode === mode)!;
  const input = (): CompanionAddInput =>
    mode === "url" ? { kind: "url", url: value } : { kind: "path", path: value };
  const add = useMutation({
    mutationFn: () => addCompanion({ data: input() }),
    onSuccess: async (result) => {
      if (result.ok) {
        await queryClient.invalidateQueries();
        reset();
        onAdded(result.digest);
      } else {
        setRefusal(result);
      }
    },
  });
  function reset() {
    setValue("");
    setRefusal(null);
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
          <DialogTitle className="text-md">Add a companion</DialogTitle>
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
          onSubmit={(event) => {
            event.preventDefault();
            setRefusal(null);
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
              {add.error instanceof Error ? add.error.message : "The companion was not added."}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={add.isPending || value.trim() === ""}>
              {add.isPending ? "Adding…" : "Add companion"}
            </Button>
          </div>
        </form>
        {refusal?.tokenKey ? (
          <div className="grid gap-2 border-t border-rule pt-3" data-add-companion-token="">
            <p className="m-0 text-sm text-muted">
              Set a Git token for this host, then add the companion again.
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
      </DialogContent>
    </Dialog>
  );
}
