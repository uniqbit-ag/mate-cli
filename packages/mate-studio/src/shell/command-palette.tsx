import { Autocomplete } from "@base-ui/react/autocomplete";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { StudioView } from "@uniqbit/mate-core/studio";
import { useEffect } from "react";

import { Icon, type IconName } from "../components/icon";
import { Dialog, DialogClose, DialogContent } from "../components/ui/dialog";
import { Kbd } from "../components/ui/fields";
import { inField } from "../lib/in-field";
import type { StudioSearch } from "../lib/search";
import { companionViewQuery } from "../lib/studio-queries";
import type { ShellData } from "../server/shell";
import { useAppearance } from "../stores/appearance";
import { copyText } from "../stores/page-ui";
import { usePalette } from "../stores/palette";
import { changeStep, groupChanges } from "../views/overview/change-group";
import {
  companionName,
  libraryViews,
  modeViews,
  openTerminal,
  useRefresh,
  VIEW_ICONS,
} from "./frame";
import { VIEW_PATHS, VIEW_TITLES } from "./views";

interface Command {
  id: string;
  label: string;
  /** Words matched besides the label. */
  keywords?: string;
  hint?: string;
  icon: IconName;
  mono?: boolean;
  run(): void;
}

interface CommandGroup {
  value: string;
  items: Command[];
}

/** Cmd/Ctrl+K anywhere, Slash outside a text field unless the page took it (Factory filter). */
function usePaletteKeys(enabled: boolean): void {
  const setOpen = usePalette((state) => state.setOpen);
  useEffect(() => {
    if (!enabled) return;
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!usePalette.getState().open);
      } else if (
        event.key === "/" &&
        !event.defaultPrevented &&
        !event.metaKey &&
        !event.ctrlKey &&
        !inField(event.target)
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    // Capture, so an open panel or dialog does not swallow the shortcut.
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, [enabled, setOpen]);
}

function useCommands(shell: ShellData, search: StudioSearch, open: boolean): CommandGroup[] {
  const navigate = useNavigate();
  const refresh = useRefresh(search);
  const cycle = useAppearance((state) => state.cycle);
  const engineering = shell.studioMode === "engineering";
  const { data } = useQuery({
    ...companionViewQuery("dashboard", search),
    enabled: open && engineering && shell.selected !== null,
  });
  const go = (view: StudioView, extra: Record<string, string> = {}) =>
    void navigate({
      to: VIEW_PATHS[view],
      search: { companion: search.companion, studioMode: search.studioMode, ...extra },
    });

  const views: Command[] = [
    ...modeViews(shell.studioMode, shell.factoryMode),
    ...libraryViews(),
  ].map((view) => ({
    id: `view-${view}`,
    label: VIEW_TITLES[view],
    hint: "View",
    icon: VIEW_ICONS[view],
    run: () => go(view),
  }));
  const changes = engineering ? (data?.changes ?? []) : [];
  const changeCommands: Command[] = changes.map((change) => ({
    id: `change-${change.name}`,
    label: change.name,
    hint: changeStep(change).situation,
    icon: "doc",
    mono: true,
    run: () => go("dashboard", { change: change.name }),
  }));
  const nextSteps: Command[] = groupChanges(changes)["needs-you"].map((change) => {
    const step = changeStep(change);
    return {
      id: `next-${change.name}`,
      label: `Copy next step: ${step.prompt}`,
      keywords: `${change.name} ${step.next}`,
      hint: step.next,
      icon: "copy",
      run: () => copyText(step.prompt, "prompt"),
    };
  });
  const actions: Command[] = [
    ...shell.companions.flatMap((companion): Command[] =>
      companion.digest === shell.selected?.digest
        ? []
        : [
            {
              id: `companion-${companion.digest}`,
              label: `Switch companion: ${companionName(companion.path)}`,
              keywords: companion.path,
              icon: "folder",
              run: () =>
                void navigate({
                  to: ".",
                  search: (previous: StudioSearch) => ({
                    ...previous,
                    companion: companion.digest,
                  }),
                }),
            },
          ],
    ),
    ...(shell.terminal
      ? [
          {
            id: "terminal",
            label: "Open the agent terminal",
            icon: "terminal",
            run: openTerminal,
          } as Command,
        ]
      : []),
    { id: "refresh", label: "Refresh", icon: "refresh", run: () => refresh.mutate() },
    {
      id: "appearance",
      label: "Switch appearance",
      keywords: "theme dark light",
      icon: "theme",
      run: cycle,
    },
  ];
  return [
    { value: "Views", items: views },
    { value: "Changes", items: changeCommands },
    { value: "Next steps", items: nextSteps },
    { value: "Actions", items: actions },
  ].filter((group) => group.items.length > 0);
}

const toText = (command: Command) => `${command.label} ${command.keywords ?? ""}`;

/** Filters the mode's views, the companion's changes and Studio's actions as the viewer types. */
export function CommandPalette({ shell, search }: { shell: ShellData; search: StudioSearch }) {
  const open = usePalette((state) => state.open);
  const setOpen = usePalette((state) => state.setOpen);
  usePaletteKeys(shell.selected !== null);
  const groups = useCommands(shell, search, open);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        id="studio-palette"
        aria-label="Command palette"
        className="flex max-h-[min(34rem,calc(100dvh-6rem))] flex-col"
      >
        <Autocomplete.Root
          open
          inline
          items={groups}
          itemToStringValue={(item) => toText(item as Command)}
          autoHighlight="always"
          keepHighlight
        >
          <div className="flex items-center gap-2.5 border-b border-rule pl-4 text-muted">
            <Icon name="search" />
            <Autocomplete.Input
              className="h-12 w-full border-0 bg-transparent pr-4 text-md text-text outline-none placeholder:text-muted"
              aria-label="Search views, changes and actions"
              placeholder="Search views, changes, actions…"
            />
          </div>
          <DialogClose className="sr-only">Close the palette</DialogClose>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            <Autocomplete.Empty>
              <p className="m-0 px-3 py-6 text-sm text-muted">Nothing matches.</p>
            </Autocomplete.Empty>
            <Autocomplete.List>
              {(group: CommandGroup) => (
                <Autocomplete.Group key={group.value} items={group.items} className="not-last:mb-1">
                  <Autocomplete.GroupLabel className="px-3 pt-2 pb-1 text-2xs font-semibold text-muted">
                    {group.value}
                  </Autocomplete.GroupLabel>
                  <Autocomplete.Collection>
                    {(command: Command) => (
                      <Autocomplete.Item
                        key={command.id}
                        value={command}
                        onClick={() => {
                          setOpen(false);
                          command.run();
                        }}
                        className="flex min-h-9 cursor-default items-center gap-2.5 rounded-[6px] px-3 text-sm outline-none select-none data-highlighted:bg-accent-soft"
                      >
                        <Icon name={command.icon} className="text-muted" />
                        <span
                          className={
                            command.mono ? "min-w-0 truncate font-mono" : "min-w-0 truncate"
                          }
                        >
                          {command.label}
                        </span>
                        {command.hint ? (
                          <span className="ml-auto flex-none text-xs text-muted">
                            {command.hint}
                          </span>
                        ) : null}
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.Collection>
                </Autocomplete.Group>
              )}
            </Autocomplete.List>
          </div>
          <div className="flex gap-3.5 border-t border-rule px-3.5 py-2 text-2xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↵</Kbd> open
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>esc</Kbd> close
            </span>
          </div>
        </Autocomplete.Root>
      </DialogContent>
    </Dialog>
  );
}
