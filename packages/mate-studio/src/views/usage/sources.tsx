import type { CompanionUsageSnapshot, UsageSource } from "@uniqbit/mate-core/studio";

import { Icon } from "../../components/icon";
import { SOURCE_LABELS } from "./model";

const STATUS_LABELS: Record<UsageSource["status"], string> = {
  ok: "Available",
  empty: "No activity",
  disabled: "Not enabled",
  unavailable: "Unavailable",
  unsupported: "Unsupported schema",
  error: "Read failed",
  timeout: "Timed out",
};
const readable = (source: UsageSource) => source.status === "ok" || source.status === "empty";
const SOURCE_METRICS: Record<UsageSource["name"], string> = {
  claude: "Tokens · API cost",
  opencode: "Tokens · reported cost",
  tokensave: "Estimated token savings",
  rtk: "Estimated token savings",
};

function summaryLabel(rows: UsageSource[], available: number, partial: boolean): string {
  const same = rows.every((row) => row.status === rows[0]!.status);
  if (available && partial) return "Partial";
  if (same) return STATUS_LABELS[rows[0]!.status];
  return available ? "Available" : "Unavailable";
}

function fallbackDetail(issue: UsageSource, partial: boolean): string {
  if (issue.status === "disabled") return "Capability not enabled for this companion.";
  if (issue.status === "empty") return "No measured activity in this period.";
  if (partial) return "Some usage records are incomplete. Expand for repository details.";
  return "Local usage metadata is readable.";
}

function sourceSummary(rows: UsageSource[]) {
  const available = rows.filter(readable).length;
  const partial = rows.some((row) => row.partial) || (available > 0 && available < rows.length);
  const label = summaryLabel(rows, available, partial);
  const issue =
    rows.find((row) => !readable(row) && row.status !== "disabled") ??
    rows.find((row) => row.partial) ??
    rows[0]!;
  const detail = issue.detail ?? fallbackDetail(issue, partial);
  return {
    available,
    label,
    detail,
    warning: partial || rows.some((row) => !readable(row) && row.status !== "disabled"),
  };
}

export function UsageSources({
  sources,
  repositories,
}: {
  sources: UsageSource[];
  repositories: CompanionUsageSnapshot["repositories"];
}) {
  return (
    <section
      id="usage-sources"
      tabIndex={-1}
      className="py-5"
      aria-labelledby="usage-sources-title"
    >
      <h2 id="usage-sources-title" className="text-base font-semibold">
        Sources and coverage
      </h2>
      <p className="mt-1 mb-3 text-xs text-muted">
        One row per tool. Expand for repository status and source notes.
      </p>
      <div className="divide-y divide-rule-soft">
        {Object.entries(SOURCE_LABELS).map(([name, label]) => {
          const rows = sources.filter((source) => source.name === name);
          if (!rows.length) return null;
          const summary = sourceSummary(rows);
          return (
            <details key={name} className="group/source py-3">
              <summary className="flex cursor-pointer list-none items-start gap-2 rounded-control text-sm outline-none focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                <Icon
                  name="right"
                  className="mt-0.5 size-3.5 text-muted transition-transform group-open/source:rotate-90 motion-reduce:transition-none"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-medium">{label}</span>
                    <span className={`text-xs ${summary.warning ? "text-warn" : "text-muted"}`}>
                      {summary.label}
                    </span>
                  </span>
                  <span className="mt-1 block text-2xs text-muted">
                    {SOURCE_METRICS[rows[0]!.name]}
                    {summary.available > 0 && (
                      <>
                        {" "}
                        · {summary.available}/{rows.length} repositories readable
                      </>
                    )}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {summary.detail}
                  </span>
                </span>
              </summary>
              <div className="mt-3 ml-5 border-l border-rule-soft pl-3 text-xs">
                <ul className="grid gap-2" aria-label={`${label} repository status`}>
                  {rows.map((row) => (
                    <li
                      key={row.repositoryId}
                      className="flex min-w-0 items-baseline justify-between gap-4"
                    >
                      <span className="min-w-0 break-words">
                        {repositories.find((repository) => repository.id === row.repositoryId)
                          ?.label ?? "Repository"}
                        {row.detail && row.detail !== summary.detail && (
                          <span className="mt-1 block leading-relaxed text-muted">
                            {row.detail}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-muted">
                        {STATUS_LABELS[row.status]}
                        {row.partial ? " · partial" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          );
        })}
      </div>
      <p className="mt-4 max-w-[70ch] text-xs leading-relaxed text-muted">
        Repository activity, not subscription billing. Shared repositories can appear in several
        companions. Savings are estimates, not bill deductions. An em dash means unknown; today is
        still in progress.
      </p>
    </section>
  );
}
