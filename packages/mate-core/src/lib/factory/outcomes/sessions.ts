/**
 * The Workset sessions a person has open in Studio's terminal. Created before both the
 * terminal and the factory's Outcomes, so neither needs the other: the terminal records
 * sessions here, the Outcomes read which Worksets are a person's and hear when one ends.
 */
export class LiveSessions {
  private readonly open = new Map<string, number>();
  private readonly listeners = new Set<(worksetId: string) => void>();

  /** A session for the Workset started; pickup leaves the Workset alone until it ends. */
  begin(worksetId: string): void {
    this.open.set(worksetId, (this.open.get(worksetId) ?? 0) + 1);
  }

  /**
   * The session left the terminal: the Workset is free at once, and listeners hear of it
   * once `reaped` settles, when its container may be free for a waiting run.
   */
  end(worksetId: string, reaped: Promise<unknown> = Promise.resolve()): void {
    const count = this.open.get(worksetId) ?? 0;
    if (count <= 1) this.open.delete(worksetId);
    else this.open.set(worksetId, count - 1);
    const announce = () => {
      for (const listener of this.listeners) listener(worksetId);
    };
    void reaped.then(announce, announce);
  }

  /** Worksets with at least one open session. */
  busy(): ReadonlySet<string> {
    return new Set(this.open.keys());
  }

  onEnded(listener: (worksetId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
