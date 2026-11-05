import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  STUDIO_MODES,
  viewsFor,
  type StudioMode,
  type StudioView,
} from "@uniqbit/mate-core/studio";

import { Icon, type IconName } from "../components/icon";
import { Count } from "../components/view-parts";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { Tooltip } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { useBrowser } from "../lib/use-browser";
import type { StudioSearch } from "../lib/search";
import { companionViewQuery, factoryQuery, holdShellForMode } from "../lib/studio-queries";
import type { ShellData } from "../server/shell";
import { useAppearance } from "../stores/appearance";
import { usePageUi } from "../stores/page-ui";
import { factoryHome } from "../views/factory/outcome";
import { groupChanges } from "../views/overview/change-group";
import { libraryViews, modeViews, VIEW_ICONS } from "./frame";
import { MODE_TITLES, VIEW_PATHS, VIEW_TITLES } from "./views";

interface SidebarProps {
  shell: ShellData;
  search: StudioSearch;
  view: StudioView;
}

const MODE_ICONS: Record<StudioMode, IconName> = { engineering: "code", analysis: "eye" };

/** Counts of what needs the person, from data the page already holds. */
function useNeedsYou(shell: ShellData, search: StudioSearch): Partial<Record<StudioView, number>> {
  const engineering = useBrowser() && shell.studioMode === "engineering" && shell.selected !== null;
  const overview = useQuery({
    ...companionViewQuery("dashboard", search),
    enabled: engineering,
  });
  const factory = useQuery({
    ...factoryQuery(shell.selected?.digest ?? ""),
    enabled: engineering && shell.factoryMode,
  });
  const counts: Partial<Record<StudioView, number>> = {};
  if (overview.data?.changes)
    counts.dashboard = groupChanges(overview.data.changes)["needs-you"].length;
  if (factory.data?.payload) {
    counts.factory = factoryHome(factory.data.payload.worksets, factory.data.runs).attention.length;
  }
  return counts;
}

export function Sidebar({ shell, search, view }: SidebarProps) {
  const rail = useAppearance((state) => state.rail);
  const toggleRail = useAppearance((state) => state.toggleRail);
  const counts = useNeedsYou(shell, search);
  const mode = shell.studioMode;
  const collapsed = rail === "min";
  return (
    <nav
      className="studio-nav flex min-h-0 flex-col gap-px overflow-x-hidden overflow-y-auto border-r border-rule bg-page px-2 pt-2 pb-2.5 max-[900px]:border-r-0 max-[900px]:flex-row max-[900px]:flex-wrap max-[900px]:items-center max-[900px]:gap-1 max-[900px]:border-b max-[900px]:border-rule"
      id="studio-rail"
      aria-label="Studio views"
    >
      {shell.selected ? (
        <>
          <NavGroup
            label={MODE_TITLES[mode]}
            views={modeViews(mode, shell.factoryMode)}
            search={search}
            current={view}
            counts={counts}
            collapsed={collapsed}
          />
          <NavGroup
            label={mode === "analysis" ? "Published" : "Library"}
            views={libraryViews()}
            search={search}
            current={view}
            counts={counts}
            collapsed={collapsed}
          />
        </>
      ) : null}
      <div className="sidebar-footer mt-auto grid gap-1 border-t border-rule-soft pt-2 max-[900px]:mt-0 max-[900px]:ml-auto max-[900px]:flex max-[900px]:border-0 max-[900px]:pt-0">
        <ModeSwitch shell={shell} search={search} view={view} collapsed={collapsed} />
        <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} disabled={!collapsed}>
          <button
            type="button"
            id="studio-rail-toggle"
            className="flex h-[30px] items-center gap-2.5 rounded-[6px] border-0 bg-transparent px-2.5 text-xs text-muted hover:bg-surface hover:text-text rail-min:justify-center rail-min:px-0 max-[900px]:hidden"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            onClick={toggleRail}
          >
            <Icon name="sidebar" />
            <span className="rail-min:hidden">Collapse</span>
            <span className="ml-auto font-mono text-2xs opacity-70 rail-min:hidden">⌘\</span>
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}

function NavGroup(props: {
  label: string;
  views: StudioView[];
  search: StudioSearch;
  current: StudioView;
  counts: Partial<Record<StudioView, number>>;
  collapsed: boolean;
}) {
  if (props.views.length === 0) return null;
  return (
    <div
      className="grid gap-px max-[900px]:flex max-[900px]:items-center"
      role="group"
      aria-label={props.label}
      data-studio-nav-section={props.label}
    >
      <h2
        className="m-0 px-2.5 pt-3.5 pb-1.5 text-[0.68rem] leading-none font-semibold text-muted first:pt-1.5 rail-min:mx-2 rail-min:my-2.5 rail-min:h-px rail-min:overflow-hidden rail-min:bg-rule-soft rail-min:p-0 rail-min:text-[0px] max-[900px]:sr-only"
        aria-hidden="true"
      >
        {props.label}
      </h2>
      {props.views.map((view) => (
        <NavLink
          key={view}
          view={view}
          search={props.search}
          current={props.current === view}
          count={props.counts[view]}
          collapsed={props.collapsed}
        />
      ))}
    </div>
  );
}

function NavLink({
  view,
  search,
  current,
  count,
  collapsed,
}: {
  view: StudioView;
  search: StudioSearch;
  current: boolean;
  count: number | undefined;
  collapsed: boolean;
}) {
  const title = VIEW_TITLES[view];
  const needs = count !== undefined && count > 0;
  return (
    <Tooltip label={title} disabled={!collapsed}>
      <Link
        to={VIEW_PATHS[view]}
        search={search}
        className={cn(
          "sidebar-nav-link relative flex h-8 items-center gap-2.5 rounded-[6px] px-2.5 text-sm whitespace-nowrap text-[color-mix(in_srgb,var(--text)_82%,var(--muted))] no-underline hover:bg-surface hover:text-text rail-min:justify-center rail-min:px-0",
          current && "bg-surface font-semibold text-text ring-1 ring-rule ring-inset",
        )}
        aria-current={current ? "page" : undefined}
        aria-label={collapsed ? (needs ? `${title}, ${count} need you` : title) : undefined}
      >
        <Icon name={VIEW_ICONS[view]} className={current ? "text-accent" : "text-muted"} />
        <span className="truncate rail-min:hidden">{title}</span>
        {view === "reports" ? <ReportsBadge /> : null}
        {needs ? (
          <Count
            value={count}
            tone="warn"
            className="ml-auto rail-min:absolute rail-min:top-1 rail-min:right-1.5 rail-min:size-[7px] rail-min:min-w-0 rail-min:bg-warn rail-min:p-0 rail-min:text-[0px]"
            label={`${count} need you`}
          />
        ) : null}
      </Link>
    </Tooltip>
  );
}

const MODE_NOTE_ID = "studio-mode-note";

/** Why a mode is shown but cannot be chosen; only the appliance disables one. */
function unavailableNote(shell: ShellData): string | null {
  const disabled = STUDIO_MODES.filter((mode) => !shell.enabledModes.includes(mode));
  if (disabled.length === 0) return null;
  const names = disabled.map((mode) => MODE_TITLES[mode]).join(" and ");
  return shell.profile === "appliance"
    ? `${names} is unavailable in the appliance.`
    : `${names} is unavailable here.`;
}

/** The Mode switch keeps the companion and, where the other mode offers it, the view. */
function ModeSwitch({
  shell,
  search,
  view,
  collapsed,
}: {
  shell: ShellData;
  search: StudioSearch;
  view: StudioView;
  collapsed: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const note = unavailableNote(shell);
  return (
    <div className="grid gap-1">
      <ToggleGroup
        aria-label="Mode"
        aria-describedby={note ? MODE_NOTE_ID : undefined}
        value={[shell.studioMode]}
        onValueChange={(next) => {
          const mode = next[0] as StudioMode | undefined;
          if (!mode || mode === shell.studioMode || !shell.enabledModes.includes(mode)) return;
          // The layout keeps standing; only the view waits for its data.
          holdShellForMode(queryClient, search, shell, mode);
          // A view the other mode is not offered lands on its Overview.
          void navigate({
            to: viewsFor(mode).includes(view) ? VIEW_PATHS[view] : "/",
            search: (previous: Record<string, unknown>) => ({ ...previous, studioMode: mode }),
          });
        }}
        className="mode-switch grid grid-cols-2 gap-0.5 rounded-control border border-rule bg-page p-0.5 rail-min:grid-cols-1"
      >
        {STUDIO_MODES.map((mode) => {
          const enabled = shell.enabledModes.includes(mode);
          return (
            <Tooltip key={mode} label={MODE_TITLES[mode]} disabled={!collapsed}>
              <ToggleGroupItem
                look="segment"
                value={mode}
                disabled={!enabled}
                aria-describedby={enabled ? undefined : MODE_NOTE_ID}
                aria-label={collapsed ? MODE_TITLES[mode] : undefined}
              >
                <Icon name={MODE_ICONS[mode]} className="hidden size-3.5 rail-min:block" />
                <span className="rail-min:hidden">{MODE_TITLES[mode]}</span>
              </ToggleGroupItem>
            </Tooltip>
          );
        })}
      </ToggleGroup>
      {note ? (
        <p className="m-0 px-1 text-2xs text-muted rail-min:sr-only" id={MODE_NOTE_ID}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** A report published while another view was shown. */
function ReportsBadge() {
  const shown = usePageUi((state) => state.reportsBadge);
  return shown ? (
    <span className="nav-badge ml-auto rounded-full bg-accent-soft px-1.5 text-2xs text-text rail-min:hidden">
      new
    </span>
  ) : null;
}
