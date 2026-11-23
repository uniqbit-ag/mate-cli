/** Field readers for parsed JSON of unknown shape, such as hook payloads and CLI output. */

/** `input` as an object whose fields can be read; an empty one for anything else. */
export const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? (input as Record<string, unknown>) : {};

/** `value` when it is a string, else empty. */
export const text = (value: unknown): string => (typeof value === "string" ? value : "");
