import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { UsageCoverage, UsageDaily, UsageMetrics } from "@uniqbit/mate-core/studio";

import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { cost, dayLabel, tokens } from "./model";

const SAVINGS_COVERAGE_NOTES: Record<UsageCoverage, string> = {
  complete: "",
  partial: " with partial coverage",
  unavailable: " and are unavailable for this scope",
};

function DailyTable({ daily, metric }: { daily: UsageDaily[]; metric: string }) {
  return (
    <div
      className="max-h-64 overflow-auto"
      tabIndex={0}
      role="region"
      aria-label="Daily usage table"
    >
      <table className="usage-table w-full text-sm">
        <caption className="sr-only">Daily token usage and cost, UTC</caption>
        <thead>
          <tr>
            <th>Date (UTC)</th>
            <th>Tokens</th>
            <th>API token cost</th>
            <th>Est. tokens saved</th>
            <th>Savings coverage</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((day) => (
            <tr key={day.date}>
              <th scope="row">{day.date}</th>
              <td>{tokens(day.metrics.totalTokens)}</td>
              <td>{cost(day.metrics.cost)}</td>
              <td>{tokens(day.metrics.savings.estimatedTokens)}</td>
              <td className="!font-sans">{day.metrics.coverage.savings}</td>
              <td className="!font-sans">
                {metric === "tokens" ? day.metrics.coverage.tokens : day.metrics.coverage.cost}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DailyChart({
  daily,
  metrics,
  metric,
}: {
  daily: UsageDaily[];
  metrics: UsageMetrics;
  metric: string;
}) {
  const data = daily.map((day) => ({
    date: day.date,
    value: metric === "tokens" ? day.metrics.totalTokens : day.metrics.cost.amount,
    saved: day.metrics.savings.estimatedTokens,
  }));
  const format = (value: number) =>
    metric === "tokens" ? tokens(value, true) : cost({ ...metrics.cost, amount: value });
  const known = data.some(
    (day) => day.value !== null || (metric === "tokens" && day.saved !== null),
  );
  if (!known)
    return (
      <p className="flex h-[210px] items-center justify-center text-sm text-muted">
        {metric === "cost"
          ? "Cost is unavailable for this scope. Token data may still be available."
          : "No readable usage source for this period."}
      </p>
    );
  return (
    <ChartContainer
      config={{
        value: {
          label: metric === "tokens" ? "Consumed tokens" : "API token cost",
          color: "var(--muted)",
        },
        saved: { label: "Estimated tokens saved", color: "var(--accent)" },
      }}
      aria-label={`Daily ${metric} chart`}
      role="group"
    >
      <BarChart accessibilityLayer data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border-soft)" />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickFormatter={(value) => dayLabel(value)}
          minTickGap={26}
          tick={{ fill: "var(--muted)", fontSize: 11 }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={60}
          tickFormatter={format}
          tick={{ fill: "var(--muted)", fontSize: 11 }}
        />
        <ChartTooltip
          filterNull={false}
          cursor={{ fill: "var(--panel)" }}
          content={<ChartTooltipContent formatter={format} />}
        />
        <Bar
          dataKey="value"
          fill="var(--color-value)"
          radius={[2, 2, 0, 0]}
          maxBarSize={56}
          isAnimationActive={false}
        />
        {metric === "tokens" && (
          <Bar
            dataKey="saved"
            fill="var(--color-saved)"
            radius={[2, 2, 0, 0]}
            maxBarSize={56}
            isAnimationActive={false}
          />
        )}
      </BarChart>
    </ChartContainer>
  );
}

function TrendNote({ metrics, metric }: { metrics: UsageMetrics; metric: string }) {
  return (
    <p className="mt-2 text-xs text-muted">
      Gaps mean unknown, not zero.{" "}
      {metrics.coverage[metric === "tokens" ? "tokens" : "cost"] === "partial"
        ? "Values shown have partial source coverage. "
        : ""}
      Use Table for exact daily values.
      {metric === "tokens" && (
        <>
          {" "}
          Savings are separate estimates
          {SAVINGS_COVERAGE_NOTES[metrics.coverage.savings]}, never subtracted from API token cost.
        </>
      )}
    </p>
  );
}

export function UsageTrend({ daily, metrics }: { daily: UsageDaily[]; metrics: UsageMetrics }) {
  const [metric, setMetric] = useState("tokens");
  const [view, setView] = useState("chart");
  return (
    <section aria-labelledby="usage-trend-title" className="border-b border-rule py-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="usage-trend-title" className="text-base font-semibold">
            Daily usage
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {metric === "tokens"
              ? "Consumed tokens (including cache) and estimated tokens saved"
              : `${metrics.cost.currency ?? "Unknown currency"} · ${metrics.cost.basis} API token cost`}{" "}
            · UTC
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <ToggleGroup
            value={[metric]}
            onValueChange={(value) => value[0] && setMetric(String(value[0]))}
            aria-label="Usage metric"
          >
            <ToggleGroupItem value="tokens" look="segment">
              Tokens
            </ToggleGroupItem>
            <ToggleGroupItem value="cost" look="segment">
              Cost
            </ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            value={[view]}
            onValueChange={(value) => value[0] && setView(String(value[0]))}
            aria-label="Trend representation"
          >
            <ToggleGroupItem value="chart" look="segment">
              Chart
            </ToggleGroupItem>
            <ToggleGroupItem value="table" look="segment">
              Table
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      {view === "table" ? (
        <DailyTable daily={daily} metric={metric} />
      ) : (
        <DailyChart daily={daily} metrics={metrics} metric={metric} />
      )}
      {view === "chart" && metric === "tokens" && (
        <div
          className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted"
          aria-label="Token chart legend"
        >
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 rounded-sm bg-muted" />
            Consumed tokens
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 rounded-sm bg-accent" />
            Estimated tokens saved
          </span>
        </div>
      )}
      <TrendNote metrics={metrics} metric={metric} />
    </section>
  );
}
