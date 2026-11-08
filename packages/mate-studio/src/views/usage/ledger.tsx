import { Fragment, useState } from "react";
import type { UsageRepository } from "@uniqbit/mate-core/studio";

import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { useMediaQuery } from "../../lib/use-media-query";
import { cost, coverageLabel, SOURCE_LABELS, tokens } from "./model";

function RepositoryDetail({ repository }: { repository: UsageRepository }) {
  const metrics = repository.metrics;
  const models = repository.breakdowns.filter(
    (row) => row.runtime === "claude" || row.runtime === "opencode",
  );
  return (
    <div className="bg-surface px-4 py-4">
      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {[
          ["Input", metrics.inputTokens],
          ["Output (including reasoning)", metrics.outputTokens],
          ["Cache read", metrics.cacheReadTokens],
          ["Cache write", metrics.cacheWriteTokens],
          ["Estimated tokens saved", metrics.savings.estimatedTokens],
          ["Savings calls", metrics.savings.calls],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="mt-1 font-mono text-sm">{tokens(value as number | null)}</dd>
          </div>
        ))}
      </dl>
      <div
        className="overflow-x-auto"
        role="region"
        tabIndex={0}
        aria-label={`Model breakdown for ${repository.label}`}
      >
        <table className="usage-table min-w-[560px] w-full text-xs">
          <caption className="sr-only">Runtime and model token breakdown</caption>
          <thead>
            <tr>
              <th>Runtime / model</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cache read</th>
              <th>Cache write</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {models.map((row) => (
              <tr key={`${row.runtime}:${row.model}`}>
                <th scope="row" className="break-all">
                  <span className="block text-muted">{SOURCE_LABELS[row.runtime]}</span>
                  {row.model}
                </th>
                <td>{tokens(row.metrics.inputTokens)}</td>
                <td>{tokens(row.metrics.outputTokens)}</td>
                <td>{tokens(row.metrics.cacheReadTokens)}</td>
                <td>{tokens(row.metrics.cacheWriteTokens)}</td>
                <td>{cost(row.metrics.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {models.length === 0 && (
        <p className="text-xs text-muted">No model records available in this period.</p>
      )}
    </div>
  );
}

const PAGE_SIZE = 50;

export function UsageLedger({ repositories }: { repositories: UsageRepository[] }) {
  const narrow = useMediaQuery("(max-width: 639px)");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(0);
  const pages = Math.ceil(repositories.length / PAGE_SIZE);
  const current = Math.min(page, Math.max(0, pages - 1));
  const rows = repositories.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  return (
    <section aria-labelledby="usage-ledger-title" className="border-b border-rule py-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="usage-ledger-title" className="text-base font-semibold">
          By repository
        </h2>
        <span className="text-xs text-muted">Expand a row for models and cache usage</span>
      </div>
      <table className="usage-table usage-ledger w-full table-fixed text-sm">
        <caption className="sr-only">
          Usage for the companion and linked Working Repositories
        </caption>
        <thead>
          <tr>
            <th className="w-[40%] max-sm:w-[48%]">Repository</th>
            <th>Tokens</th>
            <th>Cost</th>
            <th className="max-sm:hidden">Est. saved</th>
            <th className="max-sm:hidden">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((repository) => {
            const coverage = coverageLabel(repository.metrics);
            return (
              <Fragment key={repository.id}>
                <tr>
                  <th scope="row">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 py-1 text-left hover:text-accent"
                      aria-expanded={open.has(repository.id)}
                      aria-controls={`usage-detail-${repository.id}`}
                      onClick={() =>
                        setOpen((previous) => {
                          const next = new Set(previous);
                          if (next.has(repository.id)) next.delete(repository.id);
                          else next.add(repository.id);
                          return next;
                        })
                      }
                    >
                      <Icon name={open.has(repository.id) ? "chevron" : "right"} />
                      <span className="min-w-0 break-words">
                        {repository.label}
                        <span className="mt-0.5 block text-xs font-normal text-muted sm:hidden">
                          {coverage}
                        </span>
                      </span>
                    </button>
                  </th>
                  <td aria-label={`${tokens(repository.metrics.totalTokens)} tokens`}>
                    {tokens(repository.metrics.totalTokens, true)}
                  </td>
                  <td>{cost(repository.metrics.cost)}</td>
                  <td className="max-sm:hidden">
                    {tokens(repository.metrics.savings.estimatedTokens, true)}
                  </td>
                  <td className="!font-sans max-sm:hidden">
                    <span className={coverage === "Partial" ? "text-warn" : "text-muted"}>
                      {coverage}
                    </span>
                  </td>
                </tr>
                <tr hidden={!open.has(repository.id)}>
                  <td colSpan={narrow ? 3 : 5} className="!p-0 !text-left !font-sans">
                    <div id={`usage-detail-${repository.id}`}>
                      {open.has(repository.id) && <RepositoryDetail repository={repository} />}
                    </div>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-3 text-xs text-muted">
          <span>
            Page {current + 1} of {pages} · totals include every repository
          </span>
          <Button size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous
          </Button>
          <Button size="sm" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>
            Next
          </Button>
        </div>
      )}
    </section>
  );
}
