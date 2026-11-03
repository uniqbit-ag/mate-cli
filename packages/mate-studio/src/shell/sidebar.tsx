import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BRAND_SVGS,
  MODE_VIEWS,
  SHARED_VIEWS,
  STUDIO_MODES,
  viewsFor,
  type StudioMode,
  type StudioView,
} from "@uniqbit/mate-core/studio";
import { useEffect } from "react";

import type { StudioSearch } from "../lib/search";
import { getShell, type ShellData } from "../server/shell";
import { useAppearance } from "../stores/appearance";
import { LocalTime } from "./local-time";
import { MODE_TITLES, VIEW_PATHS, VIEW_TITLES } from "./views";
import { usePageUi } from "../stores/page-ui";

const svgUri = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;
const SYMBOL_COLOR_URI = svgUri(BRAND_SVGS.symbolColor);
const SYMBOL_ON_DARK_URI = svgUri(BRAND_SVGS.symbolOnDark);

interface SidebarProps {
  shell: ShellData;
  search: StudioSearch;
  view: StudioView;
}

export function Sidebar({ shell, search, view }: SidebarProps) {
  return (
    <aside className="rail studio-sidebar" id="studio-rail">
      <div className="sidebar-brand">
        {/* Both versions ship; the stylesheet shows the one matching the appearance. */}
        <img className="sidebar-brand-mark brand-symbol-color" src={SYMBOL_COLOR_URI} alt="" />
        <img className="sidebar-brand-mark brand-symbol-on-dark" src={SYMBOL_ON_DARK_URI} alt="" />
        <div className="sidebar-brand-copy">
          <strong>Mate Studio</strong>
        </div>
      </div>
      <ModeSwitch shell={shell} search={search} view={view} />
      <CompanionSelector shell={shell} />
      <ViewNav
        studioMode={shell.studioMode}
        factoryMode={shell.factoryMode}
        search={search}
        view={view}
      />
      {shell.studioMode === "engineering" && shell.metrics ? (
        <Metrics metrics={shell.metrics} />
      ) : null}
      <Footer shell={shell} search={search} />
    </aside>
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

function ModeSwitch({
  shell,
  search,
  view,
}: {
  shell: ShellData;
  search: StudioSearch;
  view: StudioView;
}) {
  const note = unavailableNote(shell);
  return (
    <div className="mode-switch-block">
      <div
        className="mode-switch"
        role="group"
        aria-label="Mode"
        aria-describedby={note ? MODE_NOTE_ID : undefined}
      >
        {STUDIO_MODES.map((next) =>
          shell.enabledModes.includes(next) ? (
            <Link
              key={next}
              className="mode-switch-option"
              // A view the other mode is not offered lands on its Overview.
              to={viewsFor(next).includes(view) ? VIEW_PATHS[view] : "/"}
              search={{ ...search, studioMode: next }}
              aria-pressed={shell.studioMode === next}
              role="button"
            >
              {MODE_TITLES[next]}
            </Link>
          ) : (
            // No target at all: a disabled button takes neither pointer nor keyboard activation.
            <button
              key={next}
              type="button"
              className="mode-switch-option"
              disabled
              aria-pressed={false}
              aria-describedby={MODE_NOTE_ID}
            >
              {MODE_TITLES[next]}
            </button>
          ),
        )}
      </div>
      {note ? (
        <p className="mode-switch-note" id={MODE_NOTE_ID}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

function CompanionSelector({ shell }: { shell: ShellData }) {
  const navigate = useNavigate();
  return (
    <div className="sidebar-scope">
      <span className="sidebar-label">Scope</span>
      <select
        aria-label="Companion Repository"
        value={shell.selected?.digest ?? ""}
        onChange={(event) =>
          void navigate({
            to: ".",
            search: (previous: StudioSearch) => ({ ...previous, companion: event.target.value }),
          })
        }
      >
        <PlaceholderOption shell={shell} />
        {shell.companions.map((companion) => (
          <option
            key={companion.digest}
            value={companion.digest}
            className={companion.unready ? "unready" : undefined}
            data-unready={companion.unready ? "true" : undefined}
          >
            {companion.note ? `${companion.path} (${companion.note})` : companion.path}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Stands in for the selection while no companion is registered or none is selected. */
function PlaceholderOption({ shell }: { shell: ShellData }) {
  if (shell.companions.length === 0) {
    return (
      <option value="" className="placeholder">
        no companion registered
      </option>
    );
  }
  if (shell.selected) return null;
  return (
    <option value="" disabled className="placeholder">
      select a companion…
    </option>
  );
}

function ViewNav({
  studioMode,
  factoryMode,
  search,
  view,
}: {
  studioMode: StudioMode;
  factoryMode: boolean;
  search: StudioSearch;
  view: StudioView;
}) {
  const modeViews = MODE_VIEWS[studioMode].filter((entry) => factoryMode || entry !== "factory");
  return (
    <nav className="sidebar-nav" aria-label="Studio views">
      {modeViews.length > 0 ? (
        <ViewSection
          label={MODE_TITLES[studioMode]}
          views={modeViews}
          search={search}
          current={view}
        />
      ) : null}
      <ViewSection label="Shared" views={SHARED_VIEWS} search={search} current={view} />
    </nav>
  );
}

function ViewSection(props: {
  label: string;
  views: readonly StudioView[];
  search: StudioSearch;
  current: StudioView;
}) {
  return (
    <div className="sidebar-nav-section" data-studio-nav-section={props.label}>
      <span className="sidebar-label">{props.label}</span>
      <div className="sidebar-nav-list">
        {props.views.map((view) => (
          <Link
            key={view}
            to={VIEW_PATHS[view]}
            search={props.search}
            className="sidebar-nav-link"
            aria-current={props.current === view ? "page" : undefined}
          >
            <span>{VIEW_TITLES[view]}</span>
            {view === "reports" ? <ReportsBadge /> : null}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Metrics({ metrics }: { metrics: NonNullable<ShellData["metrics"]> }) {
  const shown: [string, number][] = [
    ["changes", metrics.changes],
    ["done", metrics.done],
    ["specs", metrics.specs],
  ];
  return (
    <div className="sidebar-metrics" id="studio-stats">
      {shown.map(([label, value]) => (
        <div key={label} className="sidebar-metric">
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

/** The refresh control is the only thing that collects again. */
function Footer({ shell, search }: { shell: ShellData; search: StudioSearch }) {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => getShell({ data: { ...search, refresh: true } }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const theme = useAppearance((state) => state.theme);
  const cycle = useAppearance((state) => state.cycle);
  const hydrate = useAppearance((state) => state.hydrate);
  useEffect(hydrate, [hydrate]);
  return (
    <div className="sidebar-footer">
      <div className="sidebar-footer-row">
        <span className="muted">
          {shell.collectedAt === null ? (
            "no state collected"
          ) : (
            <>
              state as of <LocalTime at={shell.collectedAt} />
            </>
          )}
        </span>
        <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <button id="studio-theme" type="button" data-theme-state={theme} onClick={cycle}>
        Theme: {theme}
      </button>
    </div>
  );
}

/** A report published while another view was shown. */
function ReportsBadge() {
  const shown = usePageUi((state) => state.reportsBadge);
  return shown ? <span className="nav-badge">new</span> : null;
}
