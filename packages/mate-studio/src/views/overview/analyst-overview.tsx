import { type StudioCompanionPayload, type StudioShippedChange } from "@uniqbit/mate-core/studio";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Icon } from "../../components/icon";
import { Count, ListCard, PAGE_PAD, ROW } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { PanelHead, PanelSection, SidePanel } from "../../shell/panel";
import { Warnings } from "../warnings";
import { recentlyChangedSpecs } from "./changed-specs";

const SHIPPED_LIMIT = 20;
const CHANGED_SPECS_LIMIT = 12;

const ARCHIVE_DIR = "openspec/changes/archive";
const specPath = (capability: string) => `openspec/specs/${capability}/spec.md`;

interface AnalystOverviewProps {
  payload: Pick<StudioCompanionPayload, "shipped" | "warnings">;
}

const LINK_ROW = cn(ROW, "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-2");

/** What shipped lately and the specs it changed; never active work. */
export function AnalystOverview({ payload }: AnalystOverviewProps) {
  const [open, setOpen] = useState<string | null>(null);
  const shipped = payload.shipped.slice(0, SHIPPED_LIMIT);
  const current = shipped.find((change) => change.anchor === open) ?? null;
  return (
    <div className="analyst-overview">
      <Warnings warnings={payload.warnings} />
      <div className={cn(PAGE_PAD, "@container pb-10")}>
        <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start gap-3 @max-[760px]:grid-cols-1">
          <Shipped all={payload.shipped.length} shown={shipped} current={open} onOpen={setOpen} />
          <ChangedSpecs shipped={payload.shipped} />
        </div>
      </div>
      <SidePanel
        items={shipped.map((change) => change.anchor)}
        current={current?.anchor ?? null}
        onSelect={setOpen}
        title={current ? `Shipped change ${current.name}` : "Shipped change"}
      >
        {current ? <ShippedDetail change={current} /> : null}
      </SidePanel>
    </div>
  );
}

/** Consecutive changes archived on the same day; the list is newest first. */
function byDay(changes: StudioShippedChange[]): [string, StudioShippedChange[]][] {
  const days: [string, StudioShippedChange[]][] = [];
  for (const change of changes) {
    const last = days.at(-1);
    if (last?.[0] === change.archivedOn) last[1].push(change);
    else days.push([change.archivedOn, [change]]);
  }
  return days;
}

/** The weekday of an archive date; fixed locale and zone, so server and browser agree. */
function weekday(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en", { weekday: "long", timeZone: "UTC" });
}

function Shipped({
  all,
  shown,
  current,
  onOpen,
}: {
  all: number;
  shown: StudioShippedChange[];
  current: string | null;
  onOpen: (anchor: string) => void;
}) {
  return (
    <ListCard
      title="Recently shipped"
      count={all}
      hint={all > shown.length ? `newest ${shown.length}` : undefined}
    >
      {shown.length === 0 ? (
        <p className="empty m-0 px-4 py-3 text-sm text-muted">No shipped changes yet.</p>
      ) : (
        <ol className="analyst-days m-0 list-none p-0">
          {byDay(shown).map(([day, changes]) => (
            <li key={day} className="border-t border-rule first:border-t-0">
              <h3 className="m-0 flex items-center gap-2 bg-[color-mix(in_srgb,var(--surface)_45%,transparent)] px-4 pt-2.5 pb-1.5 text-xs font-semibold text-muted">
                <time dateTime={day} className="font-mono text-text">
                  {day}
                </time>
                {weekday(day)}
                <Count value={changes.length} />
              </h3>
              <ol className="analyst-list m-0 list-none p-0">
                {changes.map((change) => (
                  <li key={change.anchor}>
                    <button
                      type="button"
                      className={cn(ROW, "grid gap-0.5 py-2")}
                      aria-current={current === change.anchor ? "true" : undefined}
                      onClick={() => onOpen(change.anchor)}
                    >
                      <span className="analyst-row-title truncate font-mono text-sm">
                        {change.name}
                      </span>
                      <span className="truncate text-xs text-muted">
                        {change.specs.length === 0 ? "no spec changes" : change.specs.join(", ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </ListCard>
  );
}

function ShippedDetail({ change }: { change: StudioShippedChange }) {
  const dir = `${ARCHIVE_DIR}/${change.anchor}`;
  return (
    <>
      <PanelHead mono title={change.name} kicker={<span>Shipped {change.archivedOn}</span>} />
      <PanelSection title="Proposal">
        {change.hasProposal ? (
          <Link
            className="inline-flex items-center gap-2 text-sm"
            to="/vault"
            search={(previous) => ({ ...previous, path: `${dir}/proposal.md` })}
          >
            <Icon name="doc" /> Read the proposal
          </Link>
        ) : (
          <p className="m-0 text-sm text-muted">
            This change has no proposal.{" "}
            <Link to="/vault" search={(previous) => ({ ...previous, dir })}>
              Open its folder
            </Link>
          </p>
        )}
      </PanelSection>
      <PanelSection title="Specs it changed" aside={String(change.specs.length)}>
        {change.specs.length === 0 ? (
          <p className="m-0 text-sm text-muted">No spec changed.</p>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {change.specs.map((capability) => (
              <li key={capability}>
                <Link
                  className="font-mono text-sm"
                  to="/vault"
                  search={(previous) => ({ ...previous, path: specPath(capability) })}
                >
                  {capability}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </>
  );
}

function ChangedSpecs({ shipped }: { shipped: StudioShippedChange[] }) {
  const shown = recentlyChangedSpecs(shipped).slice(0, CHANGED_SPECS_LIMIT);
  return (
    <ListCard
      title="Recently changed specs"
      hint={
        <Link to="/specs" search={(previous) => previous}>
          All specs
        </Link>
      }
    >
      {shown.length === 0 ? (
        <p className="empty m-0 px-4 py-3 text-sm text-muted">
          No specs changed by shipped changes yet.
        </p>
      ) : (
        <ol className="analyst-list m-0 list-none p-0">
          {shown.map((spec, index) => (
            <li key={spec.capability}>
              <Link
                className={LINK_ROW}
                to="/vault"
                search={(previous) => ({ ...previous, path: specPath(spec.capability) })}
              >
                <span className="grid min-w-0 gap-0.5">
                  <span className="analyst-row-title truncate font-mono text-sm">
                    {spec.capability}
                  </span>
                  <span className="truncate text-xs text-muted">by {spec.change}</span>
                </span>
                {/* A run of one day names the date once. */}
                <span className="font-mono text-xs text-muted">
                  {spec.archivedOn === shown[index - 1]?.archivedOn ? null : spec.archivedOn}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </ListCard>
  );
}
