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
