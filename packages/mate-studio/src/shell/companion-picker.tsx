import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { BRAND_SVGS } from "@uniqbit/mate-core/studio";
import { useState } from "react";

import { Icon } from "../components/icon";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../components/ui/dialog";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { Input, Separator } from "../components/ui/fields";
import { cn } from "../lib/cn";
import type { StudioSearch } from "../lib/search";
import { shellQuery } from "../lib/studio-queries";
import { deleteCompanion } from "../server/companions";
import { AddCompanionDialog } from "./add-companion-dialog";
import type { ShellCompanion } from "../server/shell";
import { copyText } from "../stores/page-ui";
import { companionName } from "./frame";
import { COMPANION_STORAGE_KEY } from "./prepaint";

const svgUri = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;
const SYMBOL_COLOR_URI = svgUri(BRAND_SVGS.symbolColor);
const SYMBOL_ON_DARK_URI = svgUri(BRAND_SVGS.symbolOnDark);

/** Kept short so a row leads with what distinguishes it, not the shared prefix. */
const PAIRING_LIMIT = 3;

function pairingsText(companion: ShellCompanion): string {
  if (companion.pairings.length === 0) return "no linked working repository";
  const shown = companion.pairings.slice(0, PAIRING_LIMIT).join(", ");
  const more = companion.pairings.length - PAIRING_LIMIT;
  return more > 0 ? `${shown} +${more} more` : shown;
}

function useSelectCompanion() {
  const navigate = useNavigate();
  return (digest: string) =>
    void navigate({
      to: ".",
      search: (previous: StudioSearch) => ({ ...previous, companion: digest }),
    });
}

/** Starts loading a companion's shell on pointer or focus, so choosing it rarely waits. */
function usePrefetchCompanion() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return (digest: string) => {
    const { studioMode } = router.state.location.search as StudioSearch;
    void queryClient.prefetchQuery(shellQuery({ companion: digest, studioMode }));
  };
}

/** The brand mark, in the version matching the appearance; the stylesheet shows one. */
function BrandMark() {
  return (
    <span className="relative size-5 flex-none" aria-hidden="true">
      <img className="brand-symbol-color absolute inset-0 size-5" src={SYMBOL_COLOR_URI} alt="" />
      <img
        className="brand-symbol-on-dark absolute inset-0 size-5"
        src={SYMBOL_ON_DARK_URI}
        alt=""
      />
    </span>
  );
}

const MENU_ITEM =
  "flex w-full items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-1.5 text-left text-sm text-text hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

/** Copy its path, or delete it; deleting needs a writable Studio and is confirmed. */
function CompanionActions({
  companion,
  writable,
  onDelete,
}: {
  companion: ShellCompanion;
  writable: boolean;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const name = companionName(companion.path);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            className="mr-1.5"
            aria-label={`Actions for ${name}`}
          />
        }
      >
        <Icon name="more" />
      </PopoverTrigger>
      <PopoverContent aria-label={`Actions for ${name}`} className="w-60">
        <button
          type="button"
          className={MENU_ITEM}
          onClick={() => {
            setOpen(false);
            copyText(companion.path, "path");
          }}
        >
          <Icon name="copy" className="text-muted" />
          Copy path
        </button>
        <Separator className="my-1" />
        <button
          type="button"
          className={cn(MENU_ITEM, "text-bad")}
          disabled={!writable}
          aria-describedby={writable ? undefined : `${companion.digest}-delete-note`}
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
        >
          <Icon name="trash" />
          {companion.missing || companion.keepsFolder ? "Remove from list…" : "Delete companion…"}
        </button>
        {writable ? null : (
          <p
            className="m-0 px-2.5 pb-1.5 text-2xs text-muted"
            id={`${companion.digest}-delete-note`}
          >
            Start Studio with --writable to delete.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** What the confirmation says: a folder is deleted only when it exists and Studio created it. */
function deleteCopy(companion: ShellCompanion | null, name: string) {
  if (companion?.missing) {
    return {
      title: `Remove ${name} from the list?`,
      description:
        "Its folder is already gone; this only removes the entry from the companion list.",
      action: "Remove",
      needsName: false,
    };
  }
  if (companion?.keepsFolder) {
    return {
      title: `Remove ${name} from the list?`,
      description:
        "This only removes it from the companion list. Its folder was not created by Studio and is left where it is.",
      action: "Remove",
      needsName: false,
    };
  }
  return {
    title: `Delete ${name}?`,
    description:
      "This deletes the folder from disk, with every spec, plan and note in it, and removes it from the companion list. It cannot be undone.",
    action: "Delete companion",
    needsName: true,
  };
}

/**
 * Confirms deleting a companion. A folder on disk is deleted only after its name is typed;
 * a stale entry whose folder is gone is only removed from the list.
 */
function DeleteCompanionDialog({
  companion,
  onClose,
  onDeleted,
}: {
  companion: ShellCompanion | null;
  onClose: () => void;
  onDeleted: (companion: ShellCompanion) => void;
}) {
  const [typed, setTyped] = useState("");
  const remove = useMutation({
    mutationFn: (target: ShellCompanion) => deleteCompanion({ data: { companion: target.digest } }),
    onSuccess: (_, target) => {
      // Closing here skips onOpenChange; the next dialog must start untyped.
      setTyped("");
      onDeleted(target);
    },
  });
  const name = companion ? companionName(companion.path) : "";
  const copy = deleteCopy(companion, name);
  const confirmed = !copy.needsName || typed === name;
  return (
    <Dialog
      open={companion !== null}
      onOpenChange={(next) => {
        if (next) return;
        setTyped("");
        remove.reset();
        onClose();
      }}
    >
      <DialogContent className="grid w-[min(480px,calc(100vw-32px))] gap-4 p-5">
        <div className="grid gap-1.5">
          <DialogTitle className="text-md">{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </div>
        <code className="truncate rounded-control border border-rule bg-page px-2.5 py-1.5 font-mono text-xs">
          {companion?.path}
        </code>
        {copy.needsName ? (
          <label className="grid gap-1.5 text-sm">
            <span>
              Type <b className="font-mono">{name}</b> to confirm
            </span>
            <Input
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.currentTarget.value)}
              aria-label={`Type ${name} to confirm`}
            />
          </label>
        ) : null}
        {remove.isError ? (
          <p className="m-0 text-sm text-bad" role="alert">
            {remove.error instanceof Error
              ? remove.error.message
              : "The companion was not deleted."}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            variant="danger"
            disabled={!confirmed || remove.isPending || companion === null}
            onClick={() => companion && remove.mutate(companion)}
          >
            <Icon name="trash" />
            {remove.isPending ? "Deleting…" : copy.action}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Which companion's deletion is being confirmed, and what follows a deletion. */
function useCompanionDeletion(selected: ShellCompanion | null) {
  const [target, setTarget] = useState<ShellCompanion | null>(null);
  const queryClient = useQueryClient();
  const select = useSelectCompanion();
  const dialog = (
    <DeleteCompanionDialog
      companion={target}
      onClose={() => setTarget(null)}
      onDeleted={(deleted) => {
        setTarget(null);
        // The open companion is gone: back to the list; otherwise the list reloads.
        if (deleted.digest === selected?.digest) select("");
        try {
          if (localStorage.getItem(COMPANION_STORAGE_KEY) === deleted.digest) {
            localStorage.removeItem(COMPANION_STORAGE_KEY);
          }
        } catch {
          /* a blocked web store holds no restore to forget */
        }
        // Its queries would only refetch into errors.
        queryClient.removeQueries({ queryKey: [deleted.digest] });
        void queryClient.invalidateQueries();
      }}
    />
  );
  return { ask: setTarget, dialog };
}

/** The Add companion dialog and what follows an add: the list reloads and the new one is chosen. */
function useCompanionAdd() {
  const [open, setOpen] = useState(false);
  const select = useSelectCompanion();
  const dialog = (
    <AddCompanionDialog
      open={open}
      onClose={() => setOpen(false)}
      onAdded={(digest) => {
        setOpen(false);
        select(digest);
      }}
    />
  );
  return { ask: () => setOpen(true), dialog };
}

function CompanionRow({
  companion,
  selected,
  onChoose,
  writable,
  onDelete,
  onIntent,
  roomy = false,
}: {
  companion: ShellCompanion;
  selected: boolean;
  onChoose: () => void;
  onIntent?: () => void;
  writable: boolean;
  onDelete: () => void;
  roomy?: boolean;
}) {
  return (
    <div
      className={cn(
        "picker-row grid grid-cols-[minmax(0,1fr)_auto] items-center rounded-control hover:bg-surface-soft",
        roomy && "rounded-none border-t border-rule-soft first:border-t-0 hover:bg-surface",
        selected && "bg-accent-soft",
      )}
    >
      <button
        type="button"
        className={cn(
          "picker-card grid w-full min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 border-0 bg-transparent px-2.5 py-2 text-left text-text",
          // The page lists every companion unselected, so it has no check column.
          roomy && "grid-cols-[minmax(0,1fr)_auto] py-3.5 pr-2 pl-5",
          companion.unready && "opacity-60",
        )}
        aria-current={selected ? "true" : undefined}
        data-unready={companion.unready ? "true" : undefined}
        onClick={onChoose}
        onPointerEnter={onIntent}
        onFocus={onIntent}
      >
        {roomy ? null : (
          <span className="text-accent">{selected ? <Icon name="check" /> : null}</span>
        )}
        <span className="min-w-0">
          <b className="picker-card-name block truncate font-mono text-sm font-semibold">
            {companionName(companion.path)}
          </b>
          <small className="block truncate text-xs text-muted">
            {roomy ? <span className="picker-card-path font-mono">{companion.path} · </span> : null}
            {pairingsText(companion)}
          </small>
        </span>
        {companion.note ? <span className="text-xs text-bad">{companion.note}</span> : null}
      </button>
      <CompanionActions companion={companion} writable={writable} onDelete={onDelete} />
    </div>
  );
}

/** The top bar's brand mark: names the selected companion and switches to another. */
export function CompanionSwitcher({
  companions,
  selected,
  writable = false,
  factoryMode = false,
}: {
  companions: ShellCompanion[];
  selected: ShellCompanion | null;
  writable?: boolean;
  /** The factory broker runs: only then can a companion be added from here. */
  factoryMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const select = useSelectCompanion();
  const prefetch = usePrefetchCompanion();
  const deletion = useCompanionDeletion(selected);
  const adding = useCompanionAdd();
  // The page itself lists the companions; there is nothing to switch from yet.
  if (!selected) {
    return (
      <span className="flex items-center gap-2 px-2 py-1.5">
        <BrandMark />
        <b className="text-sm font-semibold">Mate Studio</b>
      </span>
    );
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id="studio-companion"
          className="flex max-w-[420px] min-w-[calc(var(--rail-w)-12px)] flex-[0_1_auto] items-center gap-2 rounded-control border border-transparent bg-transparent px-2 py-1.5 text-left text-text hover:border-rule hover:bg-surface data-popup-open:border-rule data-popup-open:bg-surface max-[900px]:w-auto"
          aria-label={`Companion Repository: ${selected ? companionName(selected.path) : "none selected"}`}
        >
          <BrandMark />
          <b
            className="min-w-0 truncate text-sm font-semibold rail-min:hidden"
            title={selected?.path}
          >
            {selected ? companionName(selected.path) : "Mate Studio"}
          </b>
          <Icon name="chevron" className="ml-auto text-muted rail-min:hidden" />
        </PopoverTrigger>
        <PopoverContent
          aria-label="Companion Repositories"
          className="w-[min(380px,calc(100vw-24px))]"
        >
          <PopoverTitle>Companion Repositories</PopoverTitle>
          {companions.map((companion) => (
            <CompanionRow
              key={companion.digest}
              companion={companion}
              selected={companion.digest === selected?.digest}
              onChoose={() => {
                setOpen(false);
                if (companion.digest !== selected?.digest) select(companion.digest);
              }}
              onIntent={
                companion.digest === selected?.digest ? undefined : () => prefetch(companion.digest)
              }
              writable={writable}
              onDelete={() => {
                setOpen(false);
                deletion.ask(companion);
              }}
            />
          ))}
          {companions.length === 0 ? (
            <p className="m-0 px-2.5 py-2 text-sm text-muted">
              No Companion Repository is registered.
            </p>
          ) : null}
          <Separator className="my-1" />
          {factoryMode && writable ? (
            <button
              type="button"
              className="flex items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-2 text-left text-sm text-text hover:bg-surface-soft"
              data-add-companion=""
              onClick={() => {
                setOpen(false);
                adding.ask();
              }}
            >
              <Icon name="plus" className="text-muted" />
              Add companion…
            </button>
          ) : null}
          <button
            type="button"
            className="flex items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-2 text-left text-sm text-text hover:bg-surface-soft"
            onClick={() => {
              setOpen(false);
              select("");
            }}
          >
            <Icon name="folder" className="text-muted" />
            Show all companions
          </button>
        </PopoverContent>
      </Popover>
      {deletion.dialog}
      {factoryMode && writable ? adding.dialog : null}
    </>
  );
}

/** The page while no companion is selected: every registered companion, and how to add one. */
export function CompanionPicker({
  companions,
  writable = false,
  factoryMode = false,
}: {
  companions: ShellCompanion[];
  writable?: boolean;
  factoryMode?: boolean;
}) {
  const select = useSelectCompanion();
  const prefetch = usePrefetchCompanion();
  const deletion = useCompanionDeletion(null);
  const adding = useCompanionAdd();
  return (
    <section
      className="mx-auto grid w-full max-w-[760px] gap-5 px-8 py-16 max-sm:px-4"
      aria-label="Companion Repositories"
    >
      <div className="grid gap-1.5">
        <h1 className="m-0 text-[1.7rem] font-semibold tracking-[-0.02em]">
          {companions.length === 0 ? "No Companion Repository" : "Choose a Companion Repository"}
        </h1>
        <p className="m-0 text-muted">
          {companions.length === 0
            ? "No Companion Repository is registered on this machine."
            : "Studio serves one companion at a time, and remembers the one you choose for your next visit."}
        </p>
      </div>
      {companions.length > 0 ? (
        <div className="overflow-hidden rounded-card border border-rule">
          {companions.map((companion) => (
            <CompanionRow
              key={companion.digest}
              companion={companion}
              selected={false}
              roomy
              onChoose={() => select(companion.digest)}
              onIntent={() => prefetch(companion.digest)}
              writable={writable}
              onDelete={() => deletion.ask(companion)}
            />
          ))}
        </div>
      ) : null}
      {factoryMode && writable ? (
        <div>
          <Button type="button" data-add-companion="" onClick={adding.ask}>
            <Icon name="plus" />
            Add companion…
          </Button>
        </div>
      ) : null}
      <p className="m-0 text-sm text-muted">
        To add one, run{" "}
        <code className="rounded-[6px] border border-rule bg-surface px-1.5 font-mono text-xs">
          mate companion setup
        </code>{" "}
        in a Working Repository.
      </p>
      {deletion.dialog}
      {factoryMode && writable ? adding.dialog : null}
    </section>
  );
}
