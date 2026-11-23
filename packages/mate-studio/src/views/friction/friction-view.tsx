import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  FRAMEWORK_NAME,
  FRICTION_VIEW_DAYS,
  REPORT_KINDS,
  SUBJECT_TYPES,
  type FrictionFreeReport,
  type FrictionMarkResult,
  type FrictionShown,
  type FrictionView,
  type FrictionViewDays,
  type FrictionGroup,
  type FrictionItemState,
  type StateFilter,
} from "@uniqbit/mate-core/studio";
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  RecordingButton,
  RecordingReach,
  RecordingState,
  useRetryFocus,
} from "../../components/friction-recording";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
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
import { ItemState, MarkActions, type MarkItem, plural, StateWord } from "./mark-actions";
import { type FrictionFilters, selectFriction } from "./select-friction";

const PERIODS = FRICTION_VIEW_DAYS.map((days) => ({ value: String(days), label: `${days} days` }));

const STATES: PillOption<StateFilter>[] = [
  { value: "open", label: "Open" },
  { value: "handled", label: "Handled" },
  { value: "all", label: "All" },
];
/** The type and kind selects' value for no filter. */
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

/** A fixed label column, so values start on one edge in every group and report; a narrow list keeps the width for values. */
const DETAILS =
  "m-0 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 @md:grid-cols-[6rem_minmax(0,1fr)]";

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

function Counted({ label, counts }: { label: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  return (
    <Detail label={label}>
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.map(([name, count]) => (
          <span key={name} className="font-mono tabular-nums">
            {name} <span className="text-muted">×{count}</span>
          </span>
        ))}
      </span>
    </Detail>
  );
}

function ItemFooter({
  name,
  item,
  onMark,
}: {
  name: string;
  item: Pick<FrictionGroup | FrictionFreeReport, "state" | "open">;
  onMark: MarkItem;
}) {
  return (
    <div className="mt-1 grid gap-1.5">
      {item.state ? (
        <ItemState state={item.state} time={<FrictionTime at={item.state.at} />} />
      ) : null}
      <MarkActions name={name} handled={!item.open} onMark={onMark} />
    </div>
  );
}

/** Labelled text; empty fields are left out. */
function Fields({ fields }: { fields: readonly (readonly [string, string | null])[] }) {
  const shown = fields.filter(([, text]) => text);
  if (shown.length === 0) return null;
  return (
    <dl className={cn(DETAILS, "max-w-[70ch] text-sm")}>
      {shown.map(([label, text]) => (
        <Detail key={label} label={label}>
          {text}
        </Detail>
      ))}
    </dl>
  );
}

/** One list item that opens in place; `focusKey` makes it a mark's focus target. */
function Row({
  focusKey,
  line,
  summary,
  children,
}: {
  focusKey: string;
  /** The summary line's layout once its list is wide enough for columns. */
  line: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="border-t border-rule-soft first:border-t-0" data-friction-item={focusKey}>
      <details className="group/friction">
        <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)] gap-x-2 px-4 py-2.5 hover:bg-surface focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden">
          <Icon
            name="right"
            className="mt-1 size-3.5 text-muted transition-transform group-open/friction:rotate-90 motion-reduce:transition-none"
          />
          <div className={cn("flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1", line)}>
            {summary}
          </div>
        </summary>
        <div className="mr-4 mb-3 ml-9.5 grid gap-1.5 border-l border-rule-soft pl-3">
          {children}
        </div>
      </details>
    </li>
  );
}

/**
 * A row's facts. In a narrow list they wrap after the title; once the list is wide enough each
 * fact takes a track of `--friction-facts`, so the facts line up as columns across rows.
 */
const FACTS =
  "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-xs whitespace-nowrap text-muted tabular-nums";
/** Mono `ch` tracks; "last seen " plus a medium date and short time fits 32ch in common locales. */
const LAST_SEEN_TRACK = "minmax(32ch,max-content)";
const AT_TRACK = "minmax(22ch,max-content)";
const STATE_TRACK = "11ch";

/** Which optional fact columns any row of the list fills; the others get no track. */
interface Columns {
  reports: boolean;
  state: boolean;
}

/** Holds an optional column's track in a row that has no value for it. */
function Gap({ wide }: { wide: string }) {
  return <span aria-hidden="true" className={cn("hidden", wide)} />;
}

function groupCounts(group: FrictionGroup): [string, string, string, string | null] {
  return [
    `at most ${group.maxPerSession} in one session`,
    plural(group.events, "event"),
    plural(group.sessions, "session"),
    group.reports.length > 0 ? plural(group.reports.length, "report") : null,
  ];
}

/** Each count column is as wide as its longest value in the list. */
function groupTracks(groups: FrictionGroup[], columns: Columns): string {
  const counts = groups.map(groupCounts);
  const widest = (column: number) => Math.max(...counts.map((row) => row[column]?.length ?? 0), 0);
  const tracks = [0, 1, 2].map((column) => `${widest(column)}ch`);
  if (columns.reports) tracks.push(`${widest(3)}ch`);
  tracks.push(LAST_SEEN_TRACK);
  if (columns.state) tracks.push(STATE_TRACK);
  return tracks.join(" ");
}

function reportTracks(stateColumn: boolean): string {
  return stateColumn ? `${AT_TRACK} ${STATE_TRACK}` : AT_TRACK;
}

const factsStyle = (tracks: string) => ({ "--friction-facts": tracks }) as CSSProperties;

/** The state word keeps the sans face inside the mono facts. */
function StateCell({
  state,
  column,
  wide,
}: {
  state: FrictionItemState | null;
  column: boolean;
  wide: string;
}) {
  if (state) {
    return (
      <span className="font-sans">
        <StateWord state={state} />
      </span>
    );
  }
  return column ? <Gap wide={wide} /> : null;
}

function GroupItem({
  group,
  columns,
  onMark,
}: {
  group: FrictionGroup;
  columns: Columns;
  onMark: MarkItem;
}) {
  const [peak, events, sessions, reports] = groupCounts(group);
  return (
    <Row
      focusKey={group.fingerprint}
      line="@5xl:grid @5xl:grid-cols-[minmax(0,1fr)_auto]"
      summary={
        <>
          <h3 className="m-0 min-w-0 flex-[1_1_16rem] text-base font-semibold">{group.title}</h3>
          <span className={cn(FACTS, "@3xl:grid @3xl:grid-cols-(--friction-facts)")}>
            <span>{peak}</span>
            <span>{events}</span>
            <span>{sessions}</span>
            {reports ? <span>{reports}</span> : columns.reports ? <Gap wide="@3xl:block" /> : null}
            <span>
              last seen <FrictionTime at={group.lastSeen} />
            </span>
            <StateCell state={group.state} column={columns.state} wide="@3xl:block" />
          </span>
        </>
      }
    >
      <dl className={cn(DETAILS, "text-xs")}>
        <Detail label="Fingerprint">
          <code className="font-mono">{group.fingerprint}</code>
        </Detail>
        <Detail label="First seen">
          <FrictionTime at={group.firstSeen} />
        </Detail>
        <Detail label="Last seen">
          <FrictionTime at={group.lastSeen} />
        </Detail>
        <Counted label="Mate" counts={group.versions} />
        <Counted label="Paths" counts={group.paths} />
        <Counted label="Flags" counts={group.flags} />
      </dl>
      {group.reports.length > 0 ? (
        <section aria-label={`Reports on ${group.title}`} className="mt-1">
          <h4 className="m-0 text-xs font-semibold text-muted">
            {plural(group.reports.length, "report")}
          </h4>
          <ul className="m-0 list-none p-0">
            {group.reports.map((report) => (
              <li
                key={report.id}
                className="grid gap-1 border-t border-rule-soft py-2 first:border-t-0"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                  <span className="font-semibold text-text">{report.kind}</span>
                  {report.cost ? <span>{report.cost}</span> : null}
                  <FrictionTime at={report.at} />
                </div>
                <Fields
                  fields={[
                    ["Expected", report.expected],
                    ["Evidence", report.evidence],
                    ["Workaround", report.workaround],
                  ]}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ItemFooter name={group.title} item={group} onMark={onMark} />
    </Row>
  );
}

function FreeReportItem({
  report,
  stateColumn,
  onMark,
}: {
  report: FrictionFreeReport;
  stateColumn: boolean;
  onMark: MarkItem;
}) {
  return (
    <Row
      focusKey={report.id}
      line="@3xl:grid @3xl:grid-cols-[minmax(0,1fr)_auto]"
      summary={
        <>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="m-0 min-w-0 font-mono text-sm leading-[1.375rem] font-semibold">
              {report.subject}
            </h3>
            <span className="rounded-full border border-rule bg-page px-2 font-mono text-[0.7rem] text-text">
              {report.kind}
            </span>
          </span>
          <span className={cn(FACTS, "@3xl:grid @3xl:grid-cols-(--friction-facts)")}>
            <FrictionTime at={report.at} />
            <StateCell state={report.state} column={stateColumn} wide="@3xl:block" />
          </span>
        </>
      }
    >
      <Fields
        fields={[
          ["Expected", report.expected],
          ["Cost", report.cost],
          ["Evidence", report.evidence],
          ["Workaround", report.workaround],
        ]}
      />
      <ItemFooter name={report.subject} item={report} onMark={onMark} />
    </Row>
  );
}

/** How many items the filters hide, with Show all. */
function Hidden({ hidden, onShowAll }: { hidden: number; onShowAll: () => void }) {
  return (
    <>
      {hidden === 1 ? "1 item is" : `${hidden} items are`} hidden by the filters.
      <Button
        size="sm"
        onClick={onShowAll}
        data-show-all
        aria-label={`Show all, including ${plural(hidden, "hidden item")}`}
      >
        Show all
      </Button>
    </>
  );
}

/** With `empty`, the hidden count is left to the empty message. */
function Overview({
  view,
  shown,
  empty,
  days,
  onShowAll,
}: {
  view: FrictionView;
  shown: FrictionShown;
  empty: boolean;
  days: number;
  onShowAll: () => void;
}) {
  const sections = [
    [RECORDED_SECTION, shown.groups.length],
    [REPORTS_SECTION, shown.freeReports.length],
  ] as const;
  return (
    <section aria-label="Overview" className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <p className="m-0">
          {plural(view.events, "event")} in {plural(view.sessions, "session")} in the last {days}{" "}
          days for the selected companion.
        </p>
        <nav aria-label="Friction sections" className="flex flex-wrap gap-x-4 gap-y-1">
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
      </div>
      {!empty && shown.hidden > 0 ? (
        <p className="m-0 flex flex-wrap items-center gap-2 text-muted">
          <Hidden hidden={shown.hidden} onShowAll={onShowAll} />
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="m-0 text-muted">
          To investigate, run this in your own terminal, inside the affected repository:
        </p>
        <div className="w-48 max-w-full">
          <CommandLine text={`${FRAMEWORK_NAME} triage`} label="command" />
        </div>
      </div>
    </section>
  );
}

function Recording({
  recording,
  toggle,
  button,
}: {
  recording: boolean;
  toggle: RecordingToggle;
  button?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-3">
        <RecordingState recording={recording} />
        <RecordingButton ref={button} recording={recording} toggle={toggle} />
      </div>
      <RecordingReach />
      {toggle.error ? (
        <p className="m-0 text-sm text-bad" role="alert">
          {toggle.error}
        </p>
      ) : null}
    </div>
  );
}

/** A select with a visible label beside it; `note` describes what it applies to. */
function FilterSelect<T extends string>({
  label,
  options,
  value,
  onChange,
  note,
  disabled,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  note?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-muted">
        {label}
      </label>
      <Select
        items={options}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger
          id={id}
          aria-describedby={note ? `${id}-note` : undefined}
          className="h-7 w-auto"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {note ? (
        <span id={`${id}-note`} className="text-xs text-muted">
          {note}
        </span>
      ) : null}
    </div>
  );
}

/** The selects; the state pills sit with the period. */
function Filters({
  view,
  shown,
  filters,
  onFilters,
}: {
  view: FrictionView;
  shown: FrictionShown;
  filters: FrictionFilters;
  onFilters: (filters: FrictionFilters) => void;
}) {
  const types = [
    { value: ANY, label: "All types" },
    ...shown.types.map((type) => ({ value: type, label: type })),
  ];
  const noReports = selectFriction(view, { ...filters, kind: undefined }).freeReports.length === 0;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <FilterSelect
        label="Type"
        options={types}
        value={shown.type ?? ANY}
        onChange={(type) => onFilters({ ...filters, type: oneOf(SUBJECT_TYPES, type) })}
      />
      <FilterSelect
        label="Kind"
        options={KINDS}
        value={filters.kind ?? ANY}
        onChange={(kind) => onFilters({ ...filters, kind: oneOf(REPORT_KINDS, kind) })}
        note="Agent reports only"
        // A chosen kind stays clearable.
        disabled={noReports && filters.kind === undefined}
      />
      <FilterSelect
        label="Sort"
        options={SORTS}
        value={filters.sort}
        onChange={(sort) => onFilters({ ...filters, sort })}
      />
    </div>
  );
}

/** Both sections, or one message when the filters hide every item. */
function Lists({
  shown,
  empty,
  markItem,
  onShowAll,
}: {
  shown: FrictionShown;
  empty: boolean;
  markItem: (key: string, name: string) => MarkItem;
  onShowAll: () => void;
}) {
  // Rendered only with records, so here the filters hide all of them.
  if (empty) {
    return (
      <EmptyNote className="flex flex-wrap items-center gap-x-3 gap-y-2">
        No item matches the filters. <Hidden hidden={shown.hidden} onShowAll={onShowAll} />
      </EmptyNote>
    );
  }
  const groupColumns: Columns = {
    reports: shown.groups.some((group) => group.reports.length > 0),
    state: shown.groups.some((group) => group.state !== null),
  };
  const reportState = shown.freeReports.some((report) => report.state !== null);
  return (
    <div className="grid gap-4">
      {shown.groups.length > 0 ? (
        <ListCard {...RECORDED_SECTION} count={shown.groups.length} className="wrap-anywhere">
          <ul
            className="@container m-0 list-none p-0"
            style={factsStyle(groupTracks(shown.groups, groupColumns))}
          >
            {shown.groups.map((group) => (
              <GroupItem
                key={group.fingerprint}
                group={group}
                columns={groupColumns}
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
          hint="These reports are not attached to a recorded event."
          className="wrap-anywhere"
        >
          <ul
            className="@container m-0 list-none p-0"
            style={factsStyle(reportTracks(reportState))}
          >
            {shown.freeReports.map((report) => (
              <FreeReportItem
                key={report.id}
                report={report}
                stateColumn={reportState}
                onMark={markItem(report.id, report.subject)}
              />
            ))}
          </ul>
        </ListCard>
      ) : null}
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
  recordingButton,
}: {
  view: FrictionView;
  days: FrictionViewDays;
  onDays: (days: FrictionViewDays) => void;
  toggle: RecordingToggle;
  filters: FrictionFilters;
  onFilters: (filters: FrictionFilters) => void;
  mark: MarkFriction;
  recordingButton?: Ref<HTMLButtonElement>;
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
        : panel.current?.querySelector<HTMLElement>(
            `[data-friction-item="${CSS.escape(key)}"] summary`,
          );
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
  // Show all removes itself, so focus goes to the State filter's All.
  const showAll = () => {
    const states = panel.current?.querySelectorAll<HTMLElement>('[aria-label="State"] button');
    [...(states ?? [])].find((button) => button.textContent === "All")?.focus();
    onFilters({ state: "all", sort: filters.sort });
  };
  const empty = shown.groups.length === 0 && shown.freeReports.length === 0;

  return (
    <div ref={panel} className={cn(PAGE_PAD, "grid min-w-0 gap-4 pt-3 pb-6")}>
      <Recording recording={view.recording} toggle={toggle} button={recordingButton} />
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Pills
            label="Period"
            options={PERIODS}
            value={String(days)}
            onChange={(value) => onDays(Number(value) as FrictionViewDays)}
          />
          {recorded ? (
            <Pills
              label="State"
              options={STATES}
              value={filters.state}
              onChange={(state) => onFilters({ ...filters, state })}
            />
          ) : null}
        </div>
        {recorded ? (
          <Filters view={view} shown={shown} filters={filters} onFilters={onFilters} />
        ) : null}
      </div>
      {/* Out of the grid flow: an empty region would add a second gap. */}
      <div aria-live="polite" className="sr-only">
        {marked ? <p key={marked.id}>{marked.message}</p> : null}
      </div>
      {recorded ? (
        <>
          {view.recording ? null : (
            <p className="m-0 text-sm text-muted">
              Recording is off: nothing new is recorded. The records below were made while it was
              on.
            </p>
          )}
          {/* view.days, not days: a period still loading shows the last one read. */}
          <Overview view={view} shown={shown} empty={empty} days={view.days} onShowAll={showAll} />
          <Lists shown={shown} empty={empty} markItem={markItem} onShowAll={showAll} />
        </>
      ) : (
        <EmptyNote>
          {view.recording
            ? `No friction was recorded in the last ${view.days} days.`
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
  // The previous period stays shown while another loads, so the period control keeps focus.
  const query = useQuery({
    ...frictionQuery(companion, days),
    enabled: useBrowser(),
    placeholderData: keepPreviousData,
  });
  const toggle = useSetFrictionRecording();
  const mark = useMarkFriction();
  const { button: recordingButton, retried } = useRetryFocus(query.isSuccess);
  if (!query.data && !query.isError) return <ViewLoading title="Reading the Friction Log…" />;
  const failed = query.isError ? (
    <div className={cn(PAGE_PAD, "pt-3 text-sm")} role="alert">
      <p className="m-0 text-bad">The Friction Log could not be read.</p>
      <Button
        className="mt-3"
        onClick={() => {
          retried();
          void query.refetch();
        }}
        disabled={query.isFetching}
      >
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
        recordingButton={recordingButton}
      />
    </>
  );
}
