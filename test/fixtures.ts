import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Canonical paths match file URLs and subprocess working directories on macOS. */
export async function createTempDir(prefix = "acme-test-"): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

/** Returns a restorer that removes variables which were originally absent. */
export function overrideEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export function withEnv<T>(
  name: string,
  value: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T>;
export function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T>;
export async function withEnv<T>(
  nameOrValues: string | Record<string, string | undefined>,
  valueOrFn: string | undefined | (() => Promise<T> | T),
  fn?: () => Promise<T> | T,
): Promise<T> {
  const values =
    typeof nameOrValues === "string"
      ? { [nameOrValues]: valueOrFn as string | undefined }
      : nameOrValues;
  const run = typeof nameOrValues === "string" ? fn! : (valueOrFn as () => Promise<T> | T);
  const restore = overrideEnv(values);
  try {
    return await run();
  } finally {
    restore();
  }
}
