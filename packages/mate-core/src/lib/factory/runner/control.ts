import type { RunStore } from "./state";
import { StageError } from "./workflow";

/** The companion's active changes when a person gets control; read only when needed. */
export type Baseline = () => Promise<string[]>;

/**
 * Who drives an Outcome's conversation, and every move between the two: the factory
 * (`automatic`), a person once the running stage ends (`takeover-requested`), or a person
 * now (`manual`). The only writer of a run's control state; callers hold the Workset's lock.
 */
export class OutcomeControl {
  constructor(private readonly store: RunStore) {}

  /** Whether a person has, or asked for, the conversation. */
  async withPerson(id: string): Promise<boolean> {
    return (await this.store.readControl(id)).mode !== "automatic";
  }

  /** Refuses automatic work while a person has, or asked for, the conversation. */
  async requireAutomatic(id: string): Promise<void> {
    if (await this.withPerson(id)) {
      throw new StageError("a person has control of this Outcome; return it to automation first");
    }
  }

  /**
   * A person takes control: requested while a stage runs, so it finishes first, and at once
   * otherwise. Nothing changes when a person already has, or asked for, it.
   */
  async take(id: string, running: boolean, baseline: Baseline): Promise<void> {
    if (await this.withPerson(id)) return;
    if (running) {
      await this.store.writeControl(id, {
        mode: "takeover-requested",
        updatedAt: this.store.stamp(),
      });
    } else await this.toManual(id, await baseline());
  }

  /** The stage a requested takeover waited on has ended, or never started: the person has control now. */
  async stageEnded(id: string, baseline: Baseline): Promise<void> {
    if ((await this.store.readControl(id)).mode === "takeover-requested") {
      await this.toManual(id, await baseline());
    }
  }

  /** After a restart no stage runs, so every requested takeover completes, sharing one baseline read. */
  async recover(baseline: Baseline): Promise<void> {
    let read: Promise<string[]> | undefined;
    await Promise.all(
      [...(await this.store.all()).keys()].map(async (id) => {
        if ((await this.store.readControl(id)).mode !== "takeover-requested") return;
        read ??= baseline();
        await this.toManual(id, await read);
      }),
    );
  }

  /**
   * Hands control back after `reconcile` ran with the changes that existed when the person
   * got it; false when the factory drives already. On failure the person keeps control, with
   * the reason recorded.
   */
  async giveBack(
    id: string,
    reconcile: (changesBefore: ReadonlySet<string>) => Promise<void>,
  ): Promise<boolean> {
    const control = await this.store.readControl(id);
    if (control.mode === "automatic") return false;
    if (control.mode === "takeover-requested") {
      throw new StageError("the factory is still finishing its stage; try again once it ends");
    }
    try {
      await reconcile(new Set(control.changesBefore ?? []));
    } catch (error) {
      const reason = `returning to automation failed: ${(error as Error).message}`;
      await this.store.writeControl(id, { ...control, reason, updatedAt: this.store.stamp() });
      throw new StageError(reason);
    }
    await this.store.writeControl(id, { mode: "automatic", updatedAt: this.store.stamp() });
    return true;
  }

  private toManual(id: string, changesBefore: string[]): Promise<void> {
    return this.store.writeControl(id, {
      mode: "manual",
      changesBefore,
      updatedAt: this.store.stamp(),
    });
  }
}
