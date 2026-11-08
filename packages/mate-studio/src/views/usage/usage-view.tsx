import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  CompanionUsageSnapshot,
  UsageMetrics,
  UsageRepository,
} from "@uniqbit/mate-core/studio";
import { useEffect, useState } from "react";

import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/fields";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../../components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import type { StudioSearch } from "../../lib/search";
import { useBrowser } from "../../lib/use-browser";
import { usageQuery } from "../../lib/usage-query";
import { getUsage } from "../../server/usage";
import { UsageLedger } from "./ledger";
import { UsageLoading } from "./loading";
import { cost, dayLabel, tokens, usageSelection } from "./model";
import { UsageSources } from "./sources";
import { UsageTrend } from "./trend";

const PERIODS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "custom", label: "Custom days" },
];

function RepositoryFilter({
  repositories,
  selected,
  onChange,
}: {
  repositories: UsageRepository[];
  selected?: string;
  onChange: (id?: string) => void;
}) {
  const items = [
    { value: "", label: "All repositories" },
    ...repositories.map((row) => ({ value: row.id, label: row.label })),
  ];
  return (
    <Combobox
      items={items}
      value={items.find((item) => item.value === (selected ?? ""))}
      onValueChange={(item) => {
        if (item) onChange(item.value || undefined);
      }}
      isItemEqualToValue={(a, b) => a.value === b.value}
    >
      <ComboboxInput aria-label="Filter repositories" className="w-56 max-w-full" />
      <ComboboxContent className="max-w-[calc(100vw-32px)]">
        <ComboboxEmpty>No matching Working Repository.</ComboboxEmpty>
        <ComboboxList>
          {(item: { value: string; label: string }) => (
            <ComboboxItem key={item.value} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function Totals({ metrics }: { metrics: UsageMetrics }) {
  return (
    <dl className="flex flex-wrap gap-x-10 gap-y-4 border-y border-rule py-4">
      <div>
        <dt className="text-xs text-muted">Consumed tokens</dt>
        <dd className="mt-1 font-mono text-md">
          {tokens(metrics.totalTokens)}{" "}
          <span className="font-sans text-xs text-muted">
            {metrics.coverage.tokens === "partial" ? "partial" : ""}
          </span>
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">API token cost</dt>
        <dd className="mt-1 font-mono text-md">
          {cost(metrics.cost)}{" "}
          <span className="font-sans text-xs text-muted">
            {metrics.cost.basis}
            {metrics.coverage.cost === "partial" ? " · partial" : ""}
          </span>
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Estimated tokens saved</dt>
        <dd className="mt-1 font-mono text-md">
          <strong
            className={
              metrics.savings.estimatedTokens === null
                ? "font-semibold"
                : "font-semibold text-accent"
            }
          >
            {tokens(metrics.savings.estimatedTokens)}
          </strong>{" "}
          <span className="font-sans text-xs text-muted">
            {metrics.coverage.savings !== "complete" ? metrics.coverage.savings : ""}
          </span>
        </dd>
      </div>
    </dl>
  );
}

export function UsagePanel({
  snapshot,
  days,
  repositoryId,
  busy,
  error,
  onDays,
  onRepository,
  onRefresh,
}: {
  snapshot: CompanionUsageSnapshot;
  days: number;
  repositoryId?: string;
  busy: boolean;
  error?: string;
  onDays: (days: number) => void;
  onRepository: (id?: string) => void;
  onRefresh: () => void;
}) {
  const selected = usageSelection(snapshot, repositoryId);
  const [customDays, setCustomDays] = useState(String(days));
  const [custom, setCustom] = useState(![7, 30].includes(days));
  const partial = selected.sources.some(
    (source) => source.partial || !["ok", "empty", "disabled"].includes(source.status),
  );
  return (
    <div className="usage-view min-w-0 px-6 max-[900px]:px-4" aria-busy={busy}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="usage-period">
            Usage period
          </label>
          <Select
            items={PERIODS}
            value={custom ? "custom" : String(days)}
            onValueChange={(value) => {
              if (value === null) return;
              setCustom(value === "custom");
              if (value !== "custom") onDays(Number(value));
            }}
          >
            <SelectTrigger id="usage-period" aria-label="Usage period" className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((period) => (
                <SelectItem key={period.value} value={period.value}>
                  {period.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {custom && (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const value = Number(customDays);
                if (/^\d+$/.test(customDays) && value >= 1 && value <= 365) onDays(value);
              }}
            >
              <Input
                className="!h-8 !w-20"
                type="number"
                min={1}
                max={365}
                aria-label="Custom days"
                value={customDays}
                onChange={(event) => setCustomDays(event.target.value)}
                required
              />
              <Button type="submit" size="sm">
                Apply
              </Button>
            </form>
          )}
          <RepositoryFilter
            repositories={snapshot.repositories}
            selected={selected.repositoryId}
            onChange={onRepository}
          />
          <span className="text-xs text-muted">
            {dayLabel(snapshot.window.start, true)}–
            {dayLabel(new Date(Date.parse(snapshot.window.endExclusive) - 1).toISOString(), true)} ·
            UTC
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted">
            Collected{" "}
            <time dateTime={snapshot.collectedAt}>
              {dayLabel(snapshot.collectedAt, true)},{" "}
              {new Date(snapshot.collectedAt).toISOString().slice(11, 16)} UTC
            </time>
          </span>
          <Button size="sm" disabled={busy} onClick={onRefresh}>
            <Icon name="refresh" />
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>
      <div aria-live="polite">
        {error && (
          <p className="mb-3 text-sm text-bad">
            {error} Previous values are stale.{" "}
            <button type="button" className="underline" disabled={busy} onClick={onRefresh}>
              Retry
            </button>
          </p>
        )}
      </div>
      <Totals metrics={selected.metrics} />
      {partial && (
        <p className="mt-3 text-xs text-warn">
          Partial local-source coverage.{" "}
          <a href="#usage-sources" className="!text-warn underline">
            Inspect sources
          </a>{" "}
          before interpreting totals.
        </p>
      )}
      {selected.metrics.totalTokens === null && (
        <p className="mt-3 text-sm text-muted">
          Usage is unavailable, not zero. Check the local sources below.
        </p>
      )}
      {selected.metrics.totalTokens === 0 && (
        <p className="mt-3 text-sm text-muted">
          No measured activity in this period{partial ? " from the readable sources" : ""}.
        </p>
      )}
      <UsageTrend daily={selected.daily} metrics={selected.metrics} />
      {snapshot.repositories.every((repository) => repository.kind === "companion") && (
        <p className="mt-4 text-sm text-muted">
          No Working Repositories are linked. Companion-local usage is still shown.
        </p>
      )}
      <UsageLedger key={selected.repositoryId ?? "all"} repositories={selected.repositories} />
      <UsageSources sources={selected.sources} repositories={snapshot.repositories} />
    </div>
  );
}

export function Usage({ search }: { search: StudioSearch }) {
  const companion = search.companion!;
  const days = search.usageDays ?? 7;
  const client = useQueryClient();
  const navigate = useNavigate();
  const query = useQuery({ ...usageQuery(companion, days), enabled: useBrowser() });
  const refresh = useMutation({
    mutationFn: (target: { companion: string; days: number }) =>
      getUsage({ data: { ...target, refresh: true } }),
    onSuccess: (response, target) =>
      client.setQueryData(usageQuery(target.companion, target.days).queryKey, response),
  });
  const snapshot = query.data?.snapshot;
  const refreshing = refresh.variables?.companion === companion && refresh.variables.days === days;
  const change = (fields: Partial<StudioSearch>) =>
    void navigate({ to: "/usage", search: (previous) => ({ ...previous, ...fields }) });
  useEffect(() => {
    if (
      snapshot &&
      search.usageRepository &&
      !snapshot.repositories.some((repository) => repository.id === search.usageRepository)
    )
      void navigate({
        to: "/usage",
        search: (previous) => ({ ...previous, usageRepository: undefined }),
        replace: true,
      });
  }, [snapshot, search.usageRepository, navigate]);
  const retry = () => refresh.mutate({ companion, days });
  if (!snapshot) {
    if (!query.isError && !query.data?.error && !refresh.isError) return <UsageLoading />;
    return (
      <div className="px-6 py-6 text-sm text-muted max-[900px]:px-4" role="status">
        <p>Usage could not be collected for this companion.</p>
        <Button className="mt-3" onClick={retry} disabled={refresh.isPending}>
          Retry usage collection
        </Button>
      </div>
    );
  }
  return (
    <UsagePanel
      key={`${companion}:${days}`}
      snapshot={snapshot}
      days={days}
      repositoryId={search.usageRepository}
      busy={(refreshing && refresh.isPending) || query.isFetching}
      error={
        query.data?.error?.message ??
        (refreshing && refresh.isError ? "Usage refresh failed." : undefined)
      }
      onDays={(usageDays) => change({ usageDays })}
      onRepository={(usageRepository) => change({ usageRepository })}
      onRefresh={retry}
    />
  );
}
