import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FRAMEWORK_NAME,
  FRICTION_VIEW_DAYS,
  type FrictionReport,
  type FrictionView,
  type FrictionViewDays,
  type FrictionViewGroup,
} from "@uniqbit/mate-core/studio";

import { Button } from "../../components/ui/button";
import {
  CommandLine,
  EmptyNote,
  ListCard,
  PAGE_PAD,
  Pills,
  StatusWord,
  ViewLoading,
} from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { frictionQuery, isFrictionQuery } from "../../lib/friction-query";
import { useBrowser } from "../../lib/use-browser";
import { setFrictionRecording } from "../../server/friction";
import { LocalTime } from "../../shell/local-time";

const PERIODS = FRICTION_VIEW_DAYS.map((days) => ({ value: String(days), label: `${days} days` }));

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const at = (iso: string) => <LocalTime at={Date.parse(iso)} />;

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
      <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
        {subject ? <code className="font-mono text-text">{report.subject}</code> : null}
        <span className="font-semibold text-text">{report.kind}</span>
        {report.cost ? <span>{report.cost}</span> : null}
        {at(report.at)}
      </p>
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
  return (
    <li className="grid gap-1.5 border-t border-rule-soft px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 className="m-0 text-base font-semibold">{group.title}</h3>
        <code className="font-mono text-xs text-muted">{group.fingerprint}</code>
      </div>
      <p className="m-0 text-xs text-muted">
        {plural(group.events, "event")} in {plural(group.sessions, "session")}, at most{" "}
        {group.maxPerSession} in one session · first seen {at(group.firstSeen)} · last seen{" "}
        {at(group.lastSeen)}
      </p>
      <Counted label="Mate" counts={group.versions} />
      <Counted label="Paths" counts={group.paths} />
      <Counted label="Flags" counts={group.flags} />
      {group.reports.length > 0 ? (
        <section aria-label={`Reports on ${group.title}`} className="mt-1 pl-3">
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
    </li>
  );
}

interface RecordingToggle {
  pending: boolean;
  error?: string;
  onChange: (recording: boolean) => void;
}

function Recording({ recording, toggle }: { recording: boolean; toggle: RecordingToggle }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusWord marker={recording ? "build" : "idle"}>
        Recording is {recording ? "on" : "off"}
      </StatusWord>
      <Button
        size="sm"
        variant={recording ? "default" : "primary"}
        disabled={toggle.pending}
        onClick={() => toggle.onChange(!recording)}
      >
        Turn recording {recording ? "off" : "on"}
      </Button>
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
          <p className="m-0 text-sm">
            {plural(view.events, "event")} in {plural(view.sessions, "session")} in the last {days}{" "}
            days, recorded on the machine that runs Studio.
          </p>
          {view.groups.length > 0 ? (
            <ListCard title="Recorded friction" count={view.groups.length}>
              <ul className="m-0 list-none p-0">
                {view.groups.map((group) => (
                  <GroupItem key={group.fingerprint} group={group} />
                ))}
              </ul>
            </ListCard>
          ) : null}
          {view.freeReports.length > 0 ? (
            <ListCard title="Free reports" count={view.freeReports.length}>
              <ul className="m-0 list-none px-4 py-1">
                {view.freeReports.map((report) => (
                  <ReportItem key={report.id} report={report} subject />
                ))}
              </ul>
            </ListCard>
          ) : null}
          <section aria-label="Next action" className="grid max-w-xl gap-2">
            <p className="m-0 text-sm">
              To investigate, run <code className="font-mono">{FRAMEWORK_NAME} triage</code> in your
              own terminal, inside the affected repository.
            </p>
            <CommandLine text={`${FRAMEWORK_NAME} triage`} label="command" />
          </section>
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
  const client = useQueryClient();
  const query = useQuery({ ...frictionQuery(companion, days), enabled: useBrowser() });
  const toggle = useMutation({
    mutationFn: (recording: boolean) => setFrictionRecording({ data: { recording } }),
    onSuccess: ({ recording }) => {
      client.setQueriesData<FrictionView>(
        { predicate: isFrictionQuery },
        (view) => view && { ...view, recording },
      );
      return client.invalidateQueries({ predicate: isFrictionQuery });
    },
  });
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
        toggle={{
          pending: toggle.isPending,
          error: toggle.isError
            ? `Recording could not be turned ${toggle.variables ? "on" : "off"}: ${toggle.error.message}`
            : undefined,
          onChange: (recording) => toggle.mutate(recording),
        }}
      />
    </>
  );
}
