/**
 * Writes one JSON document to stdout and resolves only once the underlying
 * write completes. `console.log`/bare `process.stdout.write` on a large
 * payload can be truncated when stdout is a pipe and the process exits
 * before the write flushes (observed at exactly the 64KB pipe boundary) —
 * awaiting the write callback is what actually guarantees delivery.
 */
export function writeJsonStdout(data: unknown, options: { space?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(data, null, options.space ?? 2)}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}
