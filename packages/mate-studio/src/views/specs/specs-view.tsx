import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type SpecActionOffer,
  type StudioCompanionPayload,
  type StudioSpec,
  type StudioSpecScope,
  SUBJECT_PATTERN,
} from "@uniqbit/mate-core/studio";
import { Fragment, useEffect, useRef, useState } from "react";

import { Icon } from "../../components/icon";
import { Input, Select } from "../../components/ui/fields";
import { EmptyNote, ListCard, PAGE_PAD, ROW, StatusWord } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { vaultQuery } from "../../lib/studio-queries";
import { PanelHead, PanelSection, SidePanel } from "../../shell/panel";
import { MarkdownView } from "../vault/markdown-view";
import { Warnings } from "../warnings";
import {
  type AreaOption,
  effectiveFilter,
  filterOptions,
  groupSpecs,
  type SpecFilter,
  type SpecFilterOptions,
} from "./spec-areas";

const NO_ACTIONS: SpecActionOffer[] = [];

const specPath = (capability: string) => `openspec/specs/${capability}/spec.md`;

function specStatus(spec: StudioSpec) {
  if (spec.valid === false) {
    return <StatusWord marker="issue">{`${spec.issueCount ?? 0} issues`}</StatusWord>;
  }
  if (spec.valid === true) return <StatusWord marker="done">valid</StatusWord>;
  return <StatusWord marker="idle">unvalidated</StatusWord>;
}

const ROOT_AREA = ".";
/** The repository-root Area reads as words; any other Area is its path. */
const areaLabel = (area: string): string => (area === ROOT_AREA ? "Repository root" : area);
const repositoryLabel = (repository: string | null): string => repository ?? "No repository";
const scopeLabel = ({ repository, area }: StudioSpecScope): string =>
  [repository, area === undefined ? undefined : areaLabel(area)].filter(Boolean).join(" · ");
/** Address writes from typing wait for a pause; the list itself narrows on every key. */
const SEARCH_COMMIT_MS = 200;

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
  /** Search and filters as the address carries them. */
  filter?: SpecFilter;
  /** Writes search and filters back to the address; without it they are kept locally. */
  onFilterChange?: (filter: SpecFilter) => void;
}

const NO_FILTER: SpecFilter = {};

/** Capabilities by repository and Area; a spec opens wide in the panel. */
export function Specs({
  payload,
  actions = NO_ACTIONS,
  companion,
  filter = NO_FILTER,
  onFilterChange,
}: SpecsProps) {
  const [local, setLocal] = useState(filter);
  return (
    <>
      <Warnings warnings={payload.warnings} />
      <SpecsByArea
        specs={payload.specs}
        actions={actions}
        companion={companion}
        filter={onFilterChange ? filter : local}
        onFilterChange={onFilterChange ?? setLocal}
      />
    </>
  );
}

/** Area filter value: the Area under a chosen repository, else the repository and Area. */
const areaValue = (option: AreaOption, scoped: boolean): string =>
  scoped ? option.area : `${option.repo}\n${option.area}`;

function SpecsToolbar({
  specs,
  options: { repositories, areas },
  filter,
  search,
  onSearch,
  onChange,
}: {
  specs: StudioSpec[];
  /** The {@link filterOptions} for the chosen repository. */
  options: SpecFilterOptions;
  /** An {@link effectiveFilter}: it carries an Area only under a chosen repository. */
  filter: SpecFilter;
  search: string;
  onSearch: (value: string) => void;
  onChange: (filter: SpecFilter) => void;
}) {
  const scoped = filter.repo !== undefined;
  const chooseRepo = (repo: string) => {
    const next = repo || undefined;
    // An Area the newly chosen repository lacks, or any Area under All, returns to All.
    const kept = filterOptions(specs, next).areas.some(
      (option) => option.repo === next && option.area === filter.area,
    );
    onChange({ ...filter, repo: next, area: kept ? filter.area : undefined });
  };
  const chooseArea = (value: string) => {
    if (!value) return onChange({ ...filter, area: undefined });
    if (scoped) return onChange({ ...filter, area: value });
    const [repo, ...rest] = value.split("\n");
    onChange({ ...filter, repo, area: rest.join("\n") });
  };
  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter specs">
      <Input
        type="search"
        className="w-64 max-sm:w-full"
        placeholder="Search capability or Area"
        aria-label="Search specs"
        value={search}
        onChange={(event) => onSearch(event.currentTarget.value)}
      />
      <Select
        className="w-auto max-w-72"
        aria-label="Repository"
        value={filter.repo ?? ""}
        onChange={(event) => chooseRepo(event.currentTarget.value)}
      >
        <option value="">All repositories</option>
        {repositories.map((option) => (
          <option key={option.value} value={option.value}>
            {`${repositoryLabel(option.repository)} (${option.count})`}
          </option>
        ))}
      </Select>
      <Select
        className="w-auto max-w-96"
        aria-label="Area"
        value={filter.area ?? ""}
        onChange={(event) => chooseArea(event.currentTarget.value)}
      >
        <option value="">All Areas</option>
        {areas.map((option) => (
          <option key={`${option.repo}\n${option.area}`} value={areaValue(option, scoped)}>
            {`${scoped ? "" : `${repositoryLabel(option.repository)} · `}${areaLabel(option.area)} (${option.count})`}
          </option>
        ))}
      </Select>
    </div>
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

function SpecRows({
  specs,
  open,
  onOpen,
}: {
  specs: StudioSpec[];
  open: string | null;
  onOpen: (capability: string) => void;
}) {
  return (
    <ul className="m-0 list-none p-0">
      {specs.map((spec) => (
        <li key={spec.capability}>
          <button
            type="button"
            className={cn(
              ROW,
              "grid grid-cols-[minmax(0,1fr)_auto_120px] py-1.5 max-sm:grid-cols-[minmax(0,1fr)_auto]",
            )}
            aria-current={open === spec.capability ? "true" : undefined}
            data-spec={spec.capability}
            onClick={() => onOpen(spec.capability)}
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
  );
}

function SpecsByArea({
  specs,
  actions,
  companion,
  filter,
  onFilterChange,
}: {
  specs: StudioSpec[];
  actions: SpecActionOffer[];
  companion?: string;
  filter: SpecFilter;
  onFilterChange: (filter: SpecFilter) => void;
}) {
  // The list narrows on every key; the address follows once typing pauses.
  const [search, setSearch] = useState(filter.q ?? "");
  // The address can change without the field (history, a link); the field then follows it.
  const [addressSearch, setAddressSearch] = useState(filter.q);
  if (filter.q !== addressSearch) {
    setAddressSearch(filter.q);
    if ((filter.q ?? "") !== search.trim()) setSearch(filter.q ?? "");
  }
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pending.current), []);
  const options = filterOptions(specs, filter.repo);
  const applied = effectiveFilter(options, { ...filter, q: search });
  const commit = (next: SpecFilter) => {
    clearTimeout(pending.current);
    onFilterChange(next);
  };
  const onSearch = (value: string) => {
    setSearch(value);
    clearTimeout(pending.current);
    pending.current = setTimeout(
      () => onFilterChange({ ...applied, q: value.trim() }),
      SEARCH_COMMIT_MS,
    );
  };
  const clear = () => {
    setSearch("");
    commit({});
  };

  const groups = groupSpecs(specs, applied);
  const [open, setOpen] = useState<string | null>(null);
  // A spec bound to several pairs is listed under each, but walked once, and only while it matches.
  const order = [
    ...new Set(
      groups.flatMap((group) =>
        group.areas.flatMap((area) => area.specs.map((spec) => spec.capability)),
      ),
    ),
  ];
  const current = specs.find((spec) => spec.capability === open) ?? null;

  return (
    <section
      className={cn(PAGE_PAD, "grid content-start gap-3 pb-10")}
      aria-label="Specs by repository and Area"
    >
      {specs.length === 0 ? (
        <EmptyNote>No specs in this companion.</EmptyNote>
      ) : (
        <>
          <SpecsToolbar
            specs={specs}
            options={options}
            filter={applied}
            search={search}
            onSearch={onSearch}
            onChange={(next) => commit({ ...next, q: search.trim() })}
          />
          {groups.length === 0 ? (
            <EmptyNote className="flex flex-wrap items-center gap-3">
              No spec matches the search and filters.
              <button type="button" className={ACTION_BUTTON} onClick={clear}>
                Clear filters
              </button>
            </EmptyNote>
          ) : (
            groups.map((group) => (
              <section
                key={group.repository ?? ""}
                className="grid content-start gap-3"
                aria-label={`Repository ${repositoryLabel(group.repository)}`}
              >
                <h2 className="m-0 mt-2 font-mono text-sm font-semibold text-muted">
                  {repositoryLabel(group.repository)}
                </h2>
                {group.areas.map(({ area, specs: areaSpecs }) => (
                  <ListCard
                    key={area}
                    level={3}
                    title={
                      area === ROOT_AREA ? (
                        areaLabel(area)
                      ) : (
                        <span className="font-mono">{area}</span>
                      )
                    }
                    label={`Area ${area}`}
                    count={areaSpecs.length}
                  >
                    <SpecRows specs={areaSpecs} open={open} onOpen={setOpen} />
                  </ListCard>
                ))}
              </section>
            ))
          )}
        </>
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

function SpecDetail({
  spec,
  actions,
  companion,
}: {
  spec: StudioSpec;
  actions: SpecActionOffer[];
  companion?: string;
}) {
  const path = specPath(spec.capability);
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
            {specStatus(spec)}
            <span className="ml-auto">{spec.scopes.map(scopeLabel).join(", ")}</span>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <SpecActions capability={spec.capability} actions={actions} />
          <Link
            className="inline-flex items-center gap-1.5 text-sm"
            to="/vault"
            search={(previous) => ({ ...previous, path })}
          >
            <Icon name="external" className="size-3.5" /> Open in Vault
          </Link>
        </div>
      </PanelHead>
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
