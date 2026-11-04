/** Runs tasks one after another per key; a failed task never blocks the next one. */
export class KeyedSerial {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** A task for `key` is queued or running. */
  has(key: string): boolean {
    return this.tails.has(key);
  }

  /** Settles once every task queued for `key` so far has; `undefined` when none is. */
  settled(key: string): Promise<void> | undefined {
    return this.tails.get(key);
  }
}
