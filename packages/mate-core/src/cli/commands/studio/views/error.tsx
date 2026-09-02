/** @jsxImportSource hono/jsx */

interface CompanionErrorProps {
  companionPath: string;
  reason: string;
}

/**
 * A companion that could not be read costs its content, never the page: the
 * selector stays rendered around this so another companion can be reached.
 */
export function CompanionError({ companionPath, reason }: CompanionErrorProps) {
  return (
    <section className="panel error">
      <h3>Could not read this companion</h3>
      <p className="mono">{companionPath}</p>
      <p>{reason}</p>
    </section>
  );
}
