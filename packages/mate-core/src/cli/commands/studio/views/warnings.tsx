/** @jsxImportSource hono/jsx */

interface WarningsProps {
  warnings: string[];
}

/** Degraded collection is reported without costing the rest of the page. */
export function Warnings({ warnings }: WarningsProps) {
  if (warnings.length === 0) return null;

  return (
    <section className="panel warnings">
      <h3>Warnings</h3>
      <ul className="plain">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </section>
  );
}
