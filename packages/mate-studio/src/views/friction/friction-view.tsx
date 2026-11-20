import { useQuery } from "@tanstack/react-query";
import {
  FRAMEWORK_NAME,
  FRICTION_VIEW_DAYS,
  REPORT_KINDS,
  SUBJECT_TYPES,
  type FrictionFreeReport,
  type FrictionMarkResult,
  type FrictionReport,
  type FrictionView,
  type FrictionViewDays,
  type FrictionViewGroup,
  type StateFilter,
} from "@uniqbit/mate-core/studio";
import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  RecordingButton,
  RecordingReach,
  RecordingState,
} from "../../components/friction-recording";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import {
  CommandLine,
  Count,
  EmptyNote,
  ListCard,
  PAGE_PAD,
  type PillOption,
  Pills,
  ViewLoading,
} from "../../components/view-parts";
import { cn } from "../../lib/cn";
import {
  frictionQuery,
  type MarkFriction,
  type RecordingToggle,
  useMarkFriction,
  useSetFrictionRecording,
} from "../../lib/friction-query";
import { type FrictionSort, oneOf } from "../../lib/search";
import { useBrowser } from "../../lib/use-browser";
import { ItemState, MarkActions, type MarkItem, plural } from "./mark-actions";
import { type FrictionFilters, type FrictionShown, selectFriction } from "./select-friction";

const PERIODS = FRICTION_VIEW_DAYS.map((days) => ({ value: String(days), label: `${days} days` }));

const STATES: PillOption<StateFilter>[] = [
  { value: "open", label: "Open" },
  { value: "handled", label: "Handled" },
  { value: "all", label: "All" },
];
/** The type and kind pills' value for no filter. */
const ANY = "any";
const KINDS = [
  { value: ANY, label: "All kinds" },
  ...REPORT_KINDS.map((kind) => ({ value: kind, label: kind })),
];
const SORTS: { value: FrictionSort; label: string }[] = [
  { value: "repeats", label: "Most repeated in one session" },
  { value: "recent", label: "Most recent" },
];

const RECORDED_SECTION = { id: "friction-recorded", title: "Recorded friction" };
const REPORTS_SECTION = { id: "friction-agent-reports", title: "Agent reports" };

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Filled in after hydration: the server's time zone may differ from the viewer's. */
function FrictionTime({ at }: { at: string }) {
  const browser = useBrowser();
  return <time dateTime={at}>{browser ? DATE_TIME.format(Date.parse(at)) : ""}</time>;
}

function Counted({ label, counts }: { label: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className="text-muted">{label}</span>
      {entries.map(([name, count]) => (
        <span key={name} className="font-mono tabular-nums">
          {name} <span className="text-muted">×{count}</span>
        </span>
      ))}
    </p>
  );
}

function ItemFooter({
  name,
  item,
  onMark,
}: {
  name: string;
  item: Pick<FrictionViewGroup | FrictionFreeReport, "state" | "open">;
  onMark: MarkItem;
}) {
  return (
    <div className="grid gap-1.5">
      {item.state ? (
        <ItemState state={item.state} time={<FrictionTime at={item.state.at} />} />
      ) : null}
      <MarkActions name={name} handled={!item.open} onMark={onMark} />
    </div>
  );
}

/** With `focusKey`, the row is a mark's focus target; `children` follow the report's text. */
function ReportItem({
  report,
  subject,
  focusKey,
  children,
}: {
  report: FrictionReport;
  subject?: boolean;
  focusKey?: string;
  children?: ReactNode;
}) {
  const fields = [
    ["Expected", report.expected],
    ["Evidence", report.evidence],
    ["Workaround", report.workaround],
  ] as const;
  return (
    <li
      className="grid gap-1 border-t border-rule-soft py-2 first:border-t-0"
      data-friction-item={focusKey}
      tabIndex={focusKey === undefined ? undefined : -1}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
        {subject ? (
          <h3 className="m-0 font-mono text-sm font-semibold text-text">{report.subject}</h3>
        ) : null}
        <span className="font-semibold text-text">{report.kind}</span>
        {report.cost ? <span>{report.cost}</span> : null}
        <FrictionTime at={report.at} />
      </div>
      {fields.map(([label, text]) =>
        text ? (
          <p key={label} className="m-0 max-w-[70ch] text-sm">
            <span className="text-muted">{label}: </span>
            {text}
          </p>
        ) : null,
      )}
      {children}
    </li>
  );
}

function GroupItem({ group, onMark }: { group: FrictionViewGroup; onMark: MarkItem }) {
  const counts = [plural(group.events, "event"), plural(group.sessions, "session")];
  if (group.reports.length > 0) counts.push(plural(group.reports.length, "report"));
  return (
    <li
      className="border-t border-rule-soft first:border-t-0"
      data-friction-item={group.fingerprint}
      tabIndex={-1}
    >
      <details className="group/friction">
        <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 px-4 py-3 hover:bg-surface focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden">
          <Icon
            name="right"
            className="mt-1 size-3.5 text-muted transition-transform group-open/friction:rotate-90 motion-reduce:transition-none"
          />
          <h3 className="m-0 text-base font-semibold">{group.title}</h3>
          <span className="col-start-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted tabular-nums">
            {counts.map((count) => (
              <span key={count} className="whitespace-nowrap">
                {count}
              </span>
            ))}
            <span>at most {group.maxPerSession} in one session</span>
            <span>
              last seen <FrictionTime at={group.lastSeen} />
            </span>
          </span>
        </summary>
        <div className="mr-4 mb-3 ml-9.5 grid gap-1.5 border-l border-rule-soft pl-3">
          <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
            <span className="text-muted">Fingerprint</span>
            <code className="font-mono">{group.fingerprint}</code>
          </p>
          <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            <span>
              First seen <FrictionTime at={group.firstSeen} />
            </span>
            <span>
              Last seen <FrictionTime at={group.lastSeen} />
            </span>
          </p>
          <Counted label="Mate" counts={group.versions} />
          <Counted label="Paths" counts={group.paths} />
          <Counted label="Flags" counts={group.flags} />
          {group.reports.length > 0 ? (
            <section aria-label={`Reports on ${group.title}`} className="mt-1">
              <h4 className="m-0 text-xs font-semibold text-muted">
                {plural(group.reports.length, "report")}
              </h4>
              <ul className="m-0 list-none p-0">
                {group.reports.map((report) => (
                  <ReportItem key={report.id} report={report} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </details>
      <div className="mr-4 mb-3 ml-9.5">
        <ItemFooter name={group.title} item={group} onMark={onMark} />
      </div>
    </li>
  );
}

function ShowAll({ hidden, onShowAll }: { hidden: number; onShowAll: () => void }) {
  return (
    <Button
      size="sm"
      onClick={onShowAll}
      data-show-all
      aria-label={`Show all, including ${plural(hidden, "hidden item")}`}
    >
      Show all
    </Button>
  );
}

function Overview({
  view,
  shown,
  days,
  onShowAll,
}: {
  view: FrictionView;
  shown: FrictionShown;
  days: FrictionViewDays;
  onShowAll: () => void;
}) {
  const sections = [
    [RECORDED_SECTION, shown.groups.length],
    [REPORTS_SECTION, shown.freeReports.length],
  ] as const;
  return (
    <section aria-label="Overview" className="grid gap-3">
      <p className="m-0 text-sm">
        {plural(view.events, "event")} in {plural(view.sessions, "session")} in the last {days} days
        for the selected companion, recorded on the machine that runs Studio.
      </p>
      <nav aria-label="Friction sections" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {sections.map(([{ id, title }, count]) =>
          count > 0 ? (
            <a
              key={id}
              href={`#${id}`}
              className="inline-flex items-center gap-1.5 rounded-control underline"
            >
              {title}
              <Count value={count} />
            </a>
          ) : null,
        )}
      </nav>
      {shown.hidden > 0 ? (
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-muted">
          {shown.hidden === 1 ? "1 item is" : `${shown.hidden} items are`} hidden by the filters.
          <ShowAll hidden={shown.hidden} onShowAll={onShowAll} />
        </p>
      ) : null}
      <div className="grid max-w-xl gap-2">
        <p className="m-0 text-sm">
          To investigate, run <code className="font-mono">{FRAMEWORK_NAME} triage</code> in your own
          terminal, inside the affected repository.
        </p>
        <CommandLine text={`${FRAMEWORK_NAME} triage`} label="command" />
      </div>
    </section>
  );
}

function Recording({ recording, toggle }: { recording: boolean; toggle: RecordingToggle }) {
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-3">
        <RecordingState recording={recording} />
        <RecordingButton recording={recording} toggle={toggle} />
      </div>
      <RecordingReach />
    </div>
  );
}

function Filters({
  shown,
  filters,
  onFilters,
}: {
  shown: FrictionShown;
  filters: FrictionFilters;
  onFilters: (filters: FrictionFilters) => void;
}) {
  const types = [
    { value: ANY, label: "All types" },
    ...shown.types.map((type) => ({ value: type, label: type })),
  ];
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Pills
        label="State"
        options={STATES}
        value={filters.state}
        onChange={(state) => onFilters({ ...filters, state })}
      />
      <Pills
        label="Subject type"
        options={types}
        value={shown.type ?? ANY}
        onChange={(type) => onFilters({ ...filters, type: oneOf(SUBJECT_TYPES, type) })}
      />
      <Pills
        label="Kind"
        options={KINDS}
        value={filters.kind ?? ANY}
        onChange={(kind) => onFilters({ ...filters, kind: oneOf(REPORT_KINDS, kind) })}
      />
      <Pills
        label="Order"
        options={SORTS}
        value={filters.sort}
        onChange={(sort) => onFilters({ ...filters, sort })}
      />
    </div>
  );
}

export function FrictionPanel({
  view,
  days,
  onDays,
  toggle,
  filters,
  onFilters,
  mark,
}: {
  view: FrictionView;
  days: FrictionViewDays;
  onDays: (days: FrictionViewDays) => void;
  toggle: RecordingToggle;
  filters: FrictionFilters;
  onFilters: (filters: FrictionFilters) => void;
  mark: MarkFriction;
}) {
  const recorded = view.events > 0 || view.freeReports.length > 0;
  const shown = selectFriction(view, filters);
  // The last mark: its announcement, and the item after it to take focus when the filter hides it.
  const [marked, setMarked] = useState<{
    /** Counts saves, so a repeated identical announcement still remounts and is read. */
    id: number;
    key: string;
    next: string | null;
    message: string;
  } | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!marked) return;
    const row = (key: string | null) =>
      key === null
        ? null
        : panel.current?.querySelector<HTMLElement>(`[data-friction-item="${CSS.escape(key)}"]`);
    // With no row left, the hidden items' Show all keeps focus in the view.
    (
      row(marked.key) ??
      row(marked.next) ??
      panel.current?.querySelector<HTMLElement>("[data-show-all]")
    )?.focus();
  }, [marked]);

  const markItem =
    (key: string, name: string): MarkItem =>
    async (state, input) => {
      const order = [
        ...shown.groups.map((group) => group.fingerprint),
        ...shown.freeReports.map((report) => report.id),
      ];
      const index = order.indexOf(key);
      const next = order[index + 1] ?? order[index - 1] ?? null;
      let result: FrictionMarkResult;
      try {
        result = await mark({ target: key, state, ...input });
      } catch (error) {
        return `The mark could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (!result.ok) return result.reason;
      setMarked((last) => ({
        id: (last?.id ?? 0) + 1,
        key,
        next,
        message: `${name}: ${state === "open" ? "reopened" : `marked ${state}`}.`,
      }));
      return null;
    };
  const showAll = () => onFilters({ state: "all", sort: filters.sort });
  const empty = shown.groups.length === 0 && shown.freeReports.length === 0;

  return (
    <div ref={panel} className={cn(PAGE_PAD, "grid min-w-0 gap-4 pt-3 pb-6")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Recording recording={view.recording} toggle={toggle} />
        <div className="flex flex-wrap items-center gap-3">
          <Pills
            label="Period"
            options={PERIODS}
            value={String(days)}
            onChange={(value) => onDays(Number(value) as FrictionViewDays)}
          />
          {recorded ? <Filters shown={shown} filters={filters} onFilters={onFilters} /> : null}
        </div>
      </div>
      <div aria-live="polite">
        {toggle.error ? (
          <p className="m-0 text-sm text-bad" role="alert">
            {toggle.error}
          </p>
        ) : null}
        {marked ? (
          <p key={marked.id} className="sr-only m-0">
            {marked.message}
          </p>
        ) : null}
      </div>
      {recorded ? (
        <>
          {view.recording ? null : (
            <p className="m-0 text-sm text-muted">
              Recording is off: nothing new is recorded. The records below were made while it was
              on.
            </p>
          )}
          <Overview view={view} shown={shown} days={days} onShowAll={showAll} />
          <div className="grid gap-4">
            {empty ? <EmptyNote>No item matches the filters.</EmptyNote> : null}
            {shown.groups.length > 0 ? (
              <ListCard {...RECORDED_SECTION} count={shown.groups.length} className="wrap-anywhere">
                <ul className="m-0 list-none p-0">
                  {shown.groups.map((group) => (
                    <GroupItem
                      key={group.fingerprint}
                      group={group}
                      onMark={markItem(group.fingerprint, group.title)}
                    />
                  ))}
                </ul>
              </ListCard>
            ) : null}
            {shown.freeReports.length > 0 ? (
              <ListCard
                {...REPORTS_SECTION}
                count={shown.freeReports.length}
                className="wrap-anywhere"
              >
                <p className="m-0 border-b border-rule-soft px-4 py-2 text-xs text-muted">
                  These reports are not attached to a recorded event.
                </p>
                <ul className="m-0 list-none px-4 py-1">
                  {shown.freeReports.map((report) => (
                    <ReportItem key={report.id} report={report} subject focusKey={report.id}>
                      <ItemFooter
                        name={report.subject}
                        item={report}
                        onMark={markItem(report.id, report.subject)}
                      />
                    </ReportItem>
                  ))}
                </ul>
              </ListCard>
            ) : null}
          </div>
        </>
      ) : (
        <EmptyNote>
          {view.recording
            ? `No friction was recorded in the last ${days} days.`
            : `Friction recording shows where Mate gets in an agent's way: its refusals and the ${FRAMEWORK_NAME} commands that fail in agent sessions on this machine. Recording is off; turn it on to start.`}
        </EmptyNote>
      )}
    </div>
  );
}

export function Friction({
  companion,
  days,
  onDays,
  filters,
  onFilters,
}: {
  companion: string;
  days: FrictionViewDays;
  onDays: (days: FrictionViewDays) => void;
  filters: FrictionFilters;
  onFilters: (filters: FrictionFilters) => void;
}) {
  const query = useQuery({ ...frictionQuery(companion, days), enabled: useBrowser() });
  const toggle = useSetFrictionRecording();
  const mark = useMarkFriction();
  if (!query.data && !query.isError) return <ViewLoading title="Reading the Friction Log…" />;
  const failed = query.isError ? (
    <div className={cn(PAGE_PAD, "pt-3 text-sm")} role="alert">
      <p className="m-0 text-bad">The Friction Log could not be read.</p>
      <Button className="mt-3" onClick={() => void query.refetch()} disabled={query.isFetching}>
        Retry
      </Button>
    </div>
  ) : null;
  if (!query.data) return failed;
  return (
    <>
      {failed}
      <FrictionPanel
        view={query.data}
        days={days}
        onDays={onDays}
        toggle={toggle}
        filters={filters}
        onFilters={onFilters}
        mark={mark}
      />
    </>
  );
}
