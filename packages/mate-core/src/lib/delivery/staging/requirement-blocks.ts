/** A requirement heading of an OpenSpec spec; the name is the first group. */
export const REQUIREMENT_HEADER = /^### Requirement:\s*(.+?)\s*$/;

/**
 * A `#` or `##` heading. With the next requirement heading, it ends a requirement block, as
 * OpenSpec reads one; deeper headings such as `### Notes` belong to the block.
 */
export function endsRequirements(line: string): boolean {
  return /^#{1,2} /.test(line);
}
