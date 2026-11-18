import { useQuery } from "@tanstack/react-query";
import {
  FRAMEWORK_NAME,
  FRICTION_VIEW_DAYS,
  type FrictionReport,
  type FrictionView,
  type FrictionViewDays,
  type FrictionViewGroup,
} from "@uniqbit/mate-core/studio";

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
  Pills,
  ViewLoading,
} from "../../components/view-parts";
import { cn } from "../../lib/cn";
import {
  frictionQuery,
  type RecordingToggle,
  useSetFrictionRecording,
} from "../../lib/friction-query";
import { useBrowser } from "../../lib/use-browser";

const PERIODS = FRICTION_VIEW_DAYS.map((days) => ({ value: String(days), label: `${days} days` }));

const RECORDED_SECTION = { id: "friction-recorded", title: "Recorded friction" };
const REPORTS_SECTION = { id: "friction-agent-reports", title: "Agent reports" };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

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

function ReportItem({ report, subject }: { report: FrictionReport; subject?: boolean }) {
  const fields = [
    ["Expected", report.expected],
    ["Evidence", report.evidence],
    ["Workaround", report.workaround],
  ] as const;
  return (
    <li className="grid gap-1 border-t border-rule-soft py-2 first:border-t-0">
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
    </li>
  );
}

function GroupItem({ group }: { group: FrictionViewGroup }) {
  const counts = [plural(group.events, "event"), plural(group.sessions, "session")];
  if (group.reports.length > 0) counts.push(plural(group.reports.length, "report"));
  return (
    <li className="border-t border-rule-soft first:border-t-0">
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
    </li>
  );
}

function Overview({ view, days }: { view: FrictionView; days: FrictionViewDays }) {
  const sections = [
    [RECORDED_SECTION, view.groups.length],
    [REPORTS_SECTION, view.freeReports.length],
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

export function FrictionPanel({
  view,
  days,
  onDays,
  toggle,
}: {
  view: FrictionView;
  days: FrictionViewDays;
  onDays: (days: FrictionViewDays) => void;
  toggle: RecordingToggle;
}) {
  const recorded = view.events > 0 || view.freeReports.length > 0;
  return (
    <div className={cn(PAGE_PAD, "grid min-w-0 gap-4 pt-3 pb-6")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Recording recording={view.recording} toggle={toggle} />
        <Pills
          label="Period"
          options={PERIODS}
          value={String(days)}
          onChange={(value) => onDays(Number(value) as FrictionViewDays)}
        />
      </div>
      <div aria-live="polite">
        {toggle.error ? (
          <p className="m-0 text-sm text-bad" role="alert">
            {toggle.error}
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
          <Overview view={view} days={days} />
          {view.groups.length > 0 ? (
            <ListCard {...RECORDED_SECTION} count={view.groups.length} className="wrap-anywhere">
              <ul className="m-0 list-none p-0">
                {view.groups.map((group) => (
                  <GroupItem key={group.fingerprint} group={group} />
                ))}
              </ul>
            </ListCard>
          ) : null}
          {view.freeReports.length > 0 ? (
            <ListCard
              {...REPORTS_SECTION}
              count={view.freeReports.length}
              className="wrap-anywhere"
            >
              <p className="m-0 border-b border-rule-soft px-4 py-2 text-xs text-muted">
                These reports are not attached to a recorded event.
              </p>
              <ul className="m-0 list-none px-4 py-1">
                {view.freeReports.map((report) => (
                  <ReportItem key={report.id} report={report} subject />
                ))}
              </ul>
            </ListCard>
          ) : null}
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
}: {
  companion: string;
  days: FrictionViewDays;
  onDays: (days: FrictionViewDays) => void;
}) {
  const query = useQuery({ ...frictionQuery(companion, days), enabled: useBrowser() });
  const toggle = useSetFrictionRecording();
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
      <FrictionPanel view={query.data} days={days} onDays={onDays} toggle={toggle} />
    </>
  );
}
