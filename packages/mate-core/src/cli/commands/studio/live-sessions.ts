import type { WorksetSessionCloseReason } from "../../../tools/setup/service";

/** Why a service ends a person's session; the terminal tells the person. */
export type SessionCloseReason = WorksetSessionCloseReason;

/** Ends a companion's sessions for a Workset; resolves once they are reaped. */
export type SessionCloser = (
  companionPath: string,
  worksetId: string,
  reason: SessionCloseReason,
) => Promise<void>;

/**
 * The Workset sessions a person has open in Studio's terminal. Created before both the
 * terminal and the services, so neither needs the other: the terminal records sessions here
 * and lends its closer, a service reads which Worksets are a person's, hears when one ends
 * and ends one itself.
 */
export class LiveSessions {
  private readonly open = new Map<string, number>();
  private readonly listeners = new Set<(worksetId: string) => void>();
  private closer: SessionCloser | null = null;

  /** The terminal's way to end sessions; without one, `close` ends nothing. */
  closeWith(closer: SessionCloser): void {
    this.closer = closer;
  }

  /** Ends the companion's sessions for the Workset, telling the person why. */
  close(companionPath: string, worksetId: string, reason: SessionCloseReason): Promise<void> {
    return this.closer?.(companionPath, worksetId, reason) ?? Promise.resolve();
  }

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
