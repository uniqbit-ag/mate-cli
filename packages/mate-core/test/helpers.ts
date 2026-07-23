import { PassThrough } from "node:stream";

export function createTtyInput(): NodeJS.ReadStream & PassThrough {
  const stdin = new PassThrough() as NodeJS.ReadStream & PassThrough;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

export function createTtyOutput(): NodeJS.WriteStream & PassThrough {
  const stream = new PassThrough() as NodeJS.WriteStream & PassThrough;
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  return stream;
}

export async function withEnv<T>(
  name: string,
  value: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}
