import { useNavigate } from "@tanstack/react-router";
import type { StudioChange } from "@uniqbit/mate-core/studio";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Age,
  CommandLine,
  Count,
  EmptyNote,
  ListCard,
  PAGE_PAD,
  Pills,
  Progress,
  ROW,
  StatusWord,
  type Marker,
} from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { PanelHead, PanelSection, SidePanel } from "../../shell/panel";
import { ArtifactReader, Artifacts } from "./artifacts";
import {
  CHANGE_GROUPS,
  changeGroup,
  changeStep,
  GROUP_TITLES,
  groupChanges,
  type ChangeGroup,
} from "./change-group";

type Filter = "all" | ChangeGroup;

const GROUP_HINTS: Record<ChangeGroup, string> = {
  "needs-you": "Review or fix before the build goes on",
  building: "An agent is working through the tasks",
  ready: "Every task is done",
};

/** A change's status word and marker shape. */
function status(change: StudioChange): { marker: Marker; word: string } {
  if (change.valid === false) return { marker: "issue", word: "Invalid" };
  const group = changeGroup(change);
  // Lilac is the Human review stage, as on the Workflow map; a plan without tasks is unfinished.
  if (group === "needs-you") {
    return (change.totalTasks ?? 0) === 0
      ? { marker: "warn", word: "No tasks" }
      : { marker: "review", word: "Review" };
  }
  if (group === "building") return { marker: "build", word: "Building" };
  return { marker: "done", word: "Ready" };
}

const PATH_STAGES = ["Propose change", "Human review", "Apply change", "Archive change"];

/** Where the change is on the Delivery Path, as four steps. */
function PathSteps({ stage }: { stage: string }) {
  const at = PATH_STAGES.indexOf(stage);
  return (
    <ol className="m-0 grid list-none grid-cols-4 gap-1 p-0" aria-label="Delivery Path">
      {PATH_STAGES.map((name, index) => (
        <li
          key={name}
          aria-current={index === at ? "step" : undefined}
          className={cn(
            "grid gap-1.5 text-2xs text-muted before:h-1 before:rounded-full before:bg-rule before:content-['']",
            index < at && "before:bg-[color-mix(in_srgb,var(--accent)_55%,var(--border))]",
            index === at && "font-semibold text-text before:bg-accent",
            index === at && name === "Human review" && "before:bg-why",
          )}
        >
          {name}
        </li>
      ))}
    </ol>
  );
}

function ChangeDetail({
  change,
  companion,
  reading,
  onRead,
}: {
  change: StudioChange;
  companion?: string;
  /** The artifact open to read, or `null` for the change's summary. */
  reading: string | null;
  onRead: (path: string | null) => void;
}) {
  const step = changeStep(change);
  const { marker, word } = status(change);
  const artifacts = (
    <PanelSection title="Artifacts" aside={change.schemaName}>
      <Artifacts change={change} companion={companion} onRead={onRead} />
    </PanelSection>
  );
  // Review needs the artifacts first; otherwise they follow the build's progress.
  const review = changeGroup(change) === "needs-you";
  return (
    <>
      <PanelHead
        mono
        title={change.name}
        kicker={
          <>
            <StatusWord marker={marker}>{word}</StatusWord>
            <Age at={change.lastModified} className="ml-auto" />
          </>
        }
      >
        <p className="m-0 text-sm text-muted">{step.situation}</p>
      </PanelHead>
      {reading && companion ? (
        <ArtifactReader
          companion={companion}
          path={reading}
          change={change}
          onBack={() => onRead(null)}
        />
      ) : (
        <>
          {review ? artifacts : null}
          <PanelSection title="Delivery Path" aside={step.stage}>
            <PathSteps stage={step.stage} />
          </PanelSection>
          <PanelSection title="Next step">
            <p className="m-0 text-sm">{step.next}.</p>
            <CommandLine text={step.prompt} />
          </PanelSection>
          <PanelSection
            title="Tasks"
            aside={`${change.completedTasks ?? 0}/${change.totalTasks ?? 0}`}
          >
            <Progress done={change.completedTasks ?? 0} total={change.totalTasks ?? 0} />
          </PanelSection>
          {review ? null : artifacts}
        </>
      )}
    </>
  );
}

function ChangeRow({
  change,
  current,
  onOpen,
}: {
  change: StudioChange;
  current: boolean;
  onOpen: () => void;
}) {
  const { marker, word } = status(change);
  const step = changeStep(change);
  return (
    <li>
      <button
        type="button"
        className={cn(
          ROW,
          "grid grid-cols-[minmax(0,1fr)_120px_150px_72px] @max-[640px]:grid-cols-[minmax(0,1fr)_auto]",
        )}
        aria-current={current ? "true" : undefined}
        data-change={change.name}
        onClick={onOpen}
      >
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate font-mono text-sm">{change.name}</span>
          <span
            className={cn("truncate text-xs", change.valid === false ? "text-bad" : "text-muted")}
          >
            {step.situation}
          </span>
        </span>
        <StatusWord marker={marker}>{word}</StatusWord>
        <span className="@max-[640px]:hidden">
          <Progress done={change.completedTasks ?? 0} total={change.totalTasks ?? 0} />
        </span>
        <Age at={change.lastModified} className="text-right @max-[640px]:hidden" />
      </button>
    </li>
  );
}

/** Active changes in up to three groups by what they need; detail opens in the panel. */
export function Changes({
  changes,
  selected,
  companion,
}: {
  changes: StudioChange[];
  selected?: string;
  /** The selected companion; the panel reads artifacts through the vault. */
  companion?: string;
}) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [pass, setPass] = useState(false);
  // Keyed by change, so moving to another change shows its summary again.
  const [reading, setReading] = useState<{ change: string; path: string } | null>(null);
  const groups = groupChanges(changes);
  const shown = CHANGE_GROUPS.filter((group) => filter === "all" || filter === group);
  const listed = shown.flatMap((group) => groups[group]);
  const walk = pass ? groups["needs-you"] : listed;
  const current = changes.find((change) => change.name === selected) ?? null;
  const readingPath = reading && reading.change === current?.name ? reading.path : null;
  const select = (name: string | null) => {
    if (name === null) setPass(false);
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, change: name ?? undefined }),
      replace: true,
    });
  };

  if (changes.length === 0) {
    return (
      <section className={cn(PAGE_PAD, "pb-10")} aria-label="Changes">
        <EmptyNote>No change is in flight in this companion.</EmptyNote>
      </section>
    );
  }
  return (
    <section
      className={cn(PAGE_PAD, "@container grid content-start gap-3 pb-10")}
      aria-label="Changes"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pills
          label="Show changes"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: changes.length },
            ...CHANGE_GROUPS.map((group) => ({
              value: group,
              label: GROUP_TITLES[group],
              count: groups[group].length,
              tone: group === "needs-you" ? ("warn" as const) : undefined,
            })),
          ]}
        />
        {groups["needs-you"].length > 0 ? (
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setPass(true);
              select(groups["needs-you"][0]!.name);
            }}
          >
            Start review pass
            <Count value={groups["needs-you"].length} />
          </Button>
        ) : null}
      </div>
      {shown.map((group) =>
        groups[group].length === 0 ? null : (
          <ListCard
            key={group}
            title={GROUP_TITLES[group]}
            count={groups[group].length}
            hint={GROUP_HINTS[group]}
            tone={group === "needs-you" ? "warn" : undefined}
          >
            <ul className="m-0 list-none p-0">
              {groups[group].map((change) => (
                <ChangeRow
                  key={change.name}
                  change={change}
                  current={change.name === selected}
                  onOpen={() => {
                    setPass(false);
                    select(change.name);
                  }}
                />
              ))}
            </ul>
          </ListCard>
        ),
      )}
      <SidePanel
        items={walk.map((change) => change.name)}
        current={current?.name ?? null}
        onSelect={select}
        pass={pass ? "Needs you" : undefined}
        wide={readingPath !== null}
        title={current ? `Change ${current.name}` : "Change"}
      >
        {current ? (
          <ChangeDetail
            change={current}
            companion={companion}
            reading={readingPath}
            onRead={(path) => setReading(path ? { change: current.name, path } : null)}
          />
        ) : null}
      </SidePanel>
    </section>
  );
}
