import { cn } from "../lib/cn";
import { PAGE_PAD } from "../components/view-parts";

interface WarningsProps {
  warnings: string[];
}

/** Degraded collection is reported without costing the rest of the page. */
export function Warnings({ warnings }: WarningsProps) {
  if (warnings.length === 0) return null;

  return (
    <section className={cn(PAGE_PAD, "pb-4")} aria-label="Warnings">
      <div className="warnings grid gap-1.5 rounded-card border border-[color-mix(in_srgb,var(--warn)_35%,var(--border))] bg-warn-soft px-4 py-3 text-sm">
        <h2 className="m-0 text-sm font-semibold text-warn">Some data could not be read</h2>
        <ul className="m-0 grid list-none gap-1 p-0">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
