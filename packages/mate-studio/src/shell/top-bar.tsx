import { useEffect } from "react";

import { Icon } from "../components/icon";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/fields";
import { Tooltip } from "../components/ui/tooltip";
import type { StudioSearch } from "../lib/search";
import type { ShellData } from "../server/shell";
import { useAppearance } from "../stores/appearance";
import { usePalette } from "../stores/palette";
import { useTerminalUi } from "../stores/terminal-ui";
import { CompanionSwitcher } from "./companion-picker";
import { toggleTerminal, useNarrowFrame, useRefresh } from "./frame";
import { LocalTime } from "./local-time";

const THEME_LABELS = {
  system: "Appearance: system",
  dark: "Appearance: dark",
  light: "Appearance: light",
};

export function TopBar({ shell, search }: { shell: ShellData; search: StudioSearch }) {
  const refresh = useRefresh(search);
  const openPalette = usePalette((state) => state.setOpen);
  const theme = useAppearance((state) => state.theme);
  const cycle = useAppearance((state) => state.cycle);
  const hydrate = useAppearance((state) => state.hydrate);
  const drawerOpen = useTerminalUi((state) => state.drawerOpen);
  const collapsed = useTerminalUi((state) => state.collapsed);
  const narrow = useNarrowFrame();
  useEffect(hydrate, [hydrate]);
  return (
    <header className="studio-top flex min-w-0 items-center gap-3.5 border-b border-rule px-3 max-[900px]:gap-2">
      <CompanionSwitcher
        companions={shell.companions}
        selected={shell.selected}
        writable={shell.writable}
        factoryMode={shell.factoryMode}
      />
      <div className="ml-auto flex min-w-0 flex-[0_1_auto] items-center justify-end gap-1.5">
        {shell.selected ? (
          <button
            type="button"
            id="studio-palette-open"
            className="mr-1.5 flex h-[34px] w-[300px] min-w-0 flex-[0_1_300px] items-center gap-2 rounded-control border border-rule bg-surface pr-2 pl-2.5 text-sm text-muted hover:border-accent max-sm:w-auto max-sm:flex-none max-sm:px-2"
            aria-label="Search views, changes and actions"
            aria-keyshortcuts="Meta+K Control+K /"
            onClick={() => openPalette(true)}
          >
            <Icon name="search" />
            <span className="truncate max-sm:hidden">Search views, changes, actions…</span>
            <Kbd className="ml-auto max-sm:hidden">⌘K</Kbd>
          </button>
        ) : null}
        {shell.selected ? (
          <span className="snapshot-status inline-flex items-center gap-2 pr-1 text-xs whitespace-nowrap text-muted max-md:hidden">
            <span className="size-[7px] rounded-full bg-accent" aria-hidden="true" />
            {shell.collectedAt === null ? (
              "No snapshot"
            ) : (
              <>
                Updated <LocalTime at={shell.collectedAt} />
              </>
            )}
          </span>
        ) : null}
        {shell.selected ? (
          <Tooltip label="Refresh" side="bottom">
            <Button
              size="icon"
              variant="ghost"
              id="studio-refresh"
              aria-label={refresh.isPending ? "Refreshing…" : "Refresh"}
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <Icon name="refresh" className={refresh.isPending ? "animate-spin" : undefined} />
            </Button>
          </Tooltip>
        ) : null}
        {shell.terminal ? (
          <Tooltip label="Agent terminal" side="bottom">
            <Button
              size="icon"
              variant="ghost"
              id="terminal-drawer-open"
              aria-label="Agent terminal"
              aria-controls="studio-terminal-panel"
              aria-expanded={narrow ? drawerOpen : !collapsed}
              onClick={toggleTerminal}
            >
              <Icon name="terminal" />
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip label={THEME_LABELS[theme]} side="bottom">
          <Button
            size="icon"
            variant="ghost"
            id="studio-theme"
            data-theme-state={theme}
            aria-label={THEME_LABELS[theme]}
            onClick={cycle}
          >
            <Icon name="theme" />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}
