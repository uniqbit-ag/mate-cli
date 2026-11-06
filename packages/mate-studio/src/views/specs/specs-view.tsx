import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  canonicalSpecPath,
  ROOT_AREA_LABEL,
  type SpecActionOffer,
  type StudioCompanionPayload,
  type StudioSpec,
  SUBJECT_PATTERN,
} from "@uniqbit/mate-core/studio";
import { Fragment, type ReactNode, useState } from "react";

import { Icon } from "../../components/icon";
import { EmptyNote, ListCard, PAGE_PAD, ROW, StatusWord } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { vaultQuery } from "../../lib/studio-queries";
import { PanelHead, PanelSection, SidePanel } from "../../shell/panel";
import { MarkdownView } from "../vault/markdown-view";
import { Warnings } from "../warnings";
import { groupSpecsByArea } from "./spec-areas";

const NO_ACTIONS: SpecActionOffer[] = [];

function specStatus(spec: StudioSpec) {
  if (spec.valid === false) {
    return <StatusWord marker="issue">{`${spec.issueCount ?? 0} issues`}</StatusWord>;
  }
  if (spec.valid === true) return <StatusWord marker="done">valid</StatusWord>;
  return <StatusWord marker="idle">unvalidated</StatusWord>;
}

const ROOT_AREA = ".";
/** The repository-root Area reads as words; any other Area is its path. */
const areaLabel = (area: string): string => (area === ROOT_AREA ? ROOT_AREA_LABEL : area);

function requirementsText(count: number | undefined): string {
  if (count === undefined) return "requirements unknown";
  return `${count} ${count === 1 ? "requirement" : "requirements"}`;
}

interface SpecsProps {
  payload: Pick<StudioCompanionPayload, "specs" | "warnings">;
  /** Skill actions offered on each spec row; none by default. */
  actions?: SpecActionOffer[];
  /** The selected companion; the panel reads the spec file through the vault. */
  companion?: string;
}

/** Capabilities by Area; a spec opens wide in the panel. */
export function Specs({ payload, actions = NO_ACTIONS, companion }: SpecsProps) {
  return (
    <>
      <Warnings warnings={payload.warnings} />
      <SpecsByArea specs={payload.specs} actions={actions} companion={companion} />
    </>
  );
}

const ACTION_BUTTON =
  "inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-rule bg-surface px-2.5 text-xs text-text hover:border-accent hover:bg-accent-soft";

function SpecActions({ capability, actions }: { capability: string; actions: SpecActionOffer[] }) {
  if (!SUBJECT_PATTERN.test(capability) || actions.length === 0) return null;
  return (
    <span className="spec-actions flex flex-wrap items-center gap-1.5">
      {actions.map(({ action, runAgents, copyAgents }) => (
        <Fragment key={action.id}>
          {runAgents.length > 0 ? (
            <button
              type="button"
              className={cn(ACTION_BUTTON, "spec-action")}
              data-studio-action={action.id}
              data-studio-subject={capability}
              data-studio-agents={runAgents.join(" ")}
            >
              <Icon name="play" className="size-3.5" />
              {action.label}
            </button>
          ) : null}
          <button
            type="button"
            className={cn(ACTION_BUTTON, "spec-copy")}
            aria-label="Copy prompt"
            data-studio-copy-prompt={action.id}
            data-prompt-claude={
              copyAgents.includes("claude") ? action.prompts.claude(capability) : undefined
            }
            data-prompt-opencode={
              copyAgents.includes("opencode") ? action.prompts.opencode(capability) : undefined
            }
          >
            <Icon name="copy" className="size-3.5" />
            Copy prompt
          </button>
        </Fragment>
      ))}
    </span>
  );
}

function SpecsByArea({
  specs,
  actions,
  companion,
}: {
  specs: StudioSpec[];
  actions: SpecActionOffer[];
  companion?: string;
}) {
  const groups = groupSpecsByArea(specs);
  const [open, setOpen] = useState<string | null>(null);
  // A spec bound to several Areas is listed under each, but walked once.
  const order = [
    ...new Set(groups.flatMap(([, areaSpecs]) => areaSpecs.map((spec) => spec.capability))),
  ];
  const current = specs.find((spec) => spec.capability === open) ?? null;

  return (
    <section className={cn(PAGE_PAD, "grid content-start gap-3 pb-10")} aria-label="Specs by Area">
      {groups.length === 0 ? (
        <EmptyNote>No specs in this companion.</EmptyNote>
      ) : (
        groups.map(([area, areaSpecs]) => (
          <ListCard
            key={area}
            title={area === ROOT_AREA ? areaLabel(area) : <span className="font-mono">{area}</span>}
            label={`Area ${area}`}
            count={areaSpecs.length}
          >
            <ul className="m-0 list-none p-0">
              {areaSpecs.map((spec) => (
                <li key={spec.capability}>
                  <button
                    type="button"
                    className={cn(
                      ROW,
                      "grid grid-cols-[minmax(0,1fr)_auto_120px] py-1.5 max-sm:grid-cols-[minmax(0,1fr)_auto]",
                    )}
                    aria-current={open === spec.capability ? "true" : undefined}
                    data-spec={spec.capability}
                    onClick={() => setOpen(spec.capability)}
                  >
                    <span className="truncate font-mono text-sm">{spec.capability}</span>
                    {/* Valid is the norm; only a spec that asks for attention is marked. */}
                    {spec.valid === true ? <span /> : specStatus(spec)}
                    <span className="text-right text-xs text-muted tabular-nums max-sm:hidden">
                      {requirementsText(spec.requirementCount)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ListCard>
        ))
      )}
      <SidePanel
        items={order}
        current={current?.capability ?? null}
        onSelect={setOpen}
        wide
        title={current ? `Spec ${current.capability}` : "Spec"}
      >
        {current ? <SpecDetail spec={current} actions={actions} companion={companion} /> : null}
      </SidePanel>
    </section>
  );
}

/** A spec's panel body: head, Vault link and the rendered spec; the Graph panel reuses it. */
export function SpecDetail({
  spec,
  actions = NO_ACTIONS,
  companion,
  withStatus = true,
  children,
}: {
  spec: StudioSpec;
  actions?: SpecActionOffer[];
  companion?: string;
  /** False where validity was never collected, e.g. in the Graph. */
  withStatus?: boolean;
  /** Sections shown between the head and the spec, e.g. the Graph's History. */
  children?: ReactNode;
}) {
  const path = canonicalSpecPath(spec.capability);
  const file = useQuery({
    ...vaultQuery(companion ?? "", { path }),
    enabled: Boolean(companion),
  });
  const markdown = file.data?.open?.markdown;
  return (
    <>
      <PanelHead
        mono
        title={spec.capability}
        kicker={
          <>
            {withStatus ? specStatus(spec) : null}
            <span className="ml-auto">{spec.areas.map(areaLabel).join(", ")}</span>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <SpecActions capability={spec.capability} actions={actions} />
          <Link
            className="inline-flex items-center gap-1.5 text-sm"
            to="/vault"
            search={(previous) => ({
              companion: previous.companion,
              studioMode: previous.studioMode,
              path,
            })}
          >
            <Icon name="external" className="size-3.5" /> Open in Vault
          </Link>
        </div>
      </PanelHead>
      {children}
      <PanelSection
        title="Spec"
        aside={
          spec.requirementCount === undefined ? undefined : requirementsText(spec.requirementCount)
        }
      >
        {markdown ? (
          <div className="prose-panel">
            <MarkdownView nodes={markdown} />
          </div>
        ) : (
          <p className="m-0 text-sm text-muted">
            {file.isError
              ? "The spec file could not be read."
              : file.isPending && companion
                ? "Loading…"
                : "The spec file could not be read."}
          </p>
        )}
      </PanelSection>
    </>
  );
}
