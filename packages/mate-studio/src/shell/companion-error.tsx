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
    <section className="error mx-8 grid gap-1.5 rounded-card border border-[color-mix(in_srgb,var(--bad)_40%,var(--border))] bg-bad-soft px-5 py-4 max-sm:mx-4">
      <h2 className="m-0 text-md font-semibold text-bad">Could not read this companion</h2>
      <p className="m-0 font-mono text-xs break-all">{companionPath}</p>
      <p className="m-0 text-sm">{reason}</p>
    </section>
  );
}
