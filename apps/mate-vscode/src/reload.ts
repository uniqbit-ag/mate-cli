/** Automatic section reloads: one gate shared by the interval, window focus, and the registry watcher. */

/** A section as the gate sees it. */
export interface ReloadTarget {
  readonly view: { readonly visible: boolean };
  readonly loading: Promise<void> | undefined;
  refresh(): void;
}

const RELOAD_MIN_GAP_MS = 3_000;
const DEFAULT_INTERVAL_SECONDS = 30;
const MIN_INTERVAL_SECONDS = 5;

/** Seconds between interval reloads from `mate.autoRefreshInterval`; 0 is off, 1–4 count as 5. */
export function intervalSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  return value === 0 ? 0 : Math.max(MIN_INTERVAL_SECONDS, value);
}

export class ReloadGate {
  private reloadedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly focused: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until the gap since the previous reload allows another one. */
  wait(): number {
    return Math.max(0, this.reloadedAt + RELOAD_MIN_GAP_MS - this.now());
  }

  /** Records a reload the caller ran itself. */
  mark(): void {
    this.reloadedAt = this.now();
  }

  /**
   * Refreshes the visible targets unless the window is unfocused, a target is
   * still loading, or the previous reload is too recent. Returns the refreshed ones.
   */
  reload(targets: readonly ReloadTarget[]): ReloadTarget[] {
    if (!this.focused() || this.wait() > 0) return [];
    if (targets.some((target) => target.loading)) return [];
    const shown = targets.filter((target) => target.view.visible);
    if (shown.length === 0) return [];
    this.mark();
    for (const target of shown) target.refresh();
    return shown;
  }
}
