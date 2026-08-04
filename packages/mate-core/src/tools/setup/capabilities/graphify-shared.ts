import { FRAMEWORK_NAME } from "../../../framework";
import {
  removeHeadingSection,
  type RemoveHeadingSectionOptions,
} from "../providers/agent-file-sections";

// Identity of the agent-file section `graphify install` writes. Declared in a
// leaf module (capability-owned) so both the graphify capability and the
// guidance plugin can consume it without an import cycle.

// Marker names derive from the framework identity, never the invocation name.
export const GRAPHIFY_START = () => `<!-- ${FRAMEWORK_NAME.toUpperCase()}:GRAPHIFY:START -->`;
export const GRAPHIFY_END = () => `<!-- ${FRAMEWORK_NAME.toUpperCase()}:GRAPHIFY:END -->`;

export function isGraphifyHeading(line: string): boolean {
  return /^#{1,6}\s+graphify\s*$/i.test(line);
}

/** Section identity passed to the Runtime Surface escape hatch. */
export function graphifySectionOptions(): RemoveHeadingSectionOptions {
  return { isHeading: isGraphifyHeading, markerLines: [GRAPHIFY_START(), GRAPHIFY_END()] };
}

// Removes the graphify section from content, collapsing leftover blank lines.
export function removeGraphifySection(content: string): string {
  return removeHeadingSection(content, graphifySectionOptions());
}
