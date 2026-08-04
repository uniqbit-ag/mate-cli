import { describe, expect, test } from "bun:test";

import { cutFromMarker, removeHeadingSection } from "./agent-file-sections";

const isGraphifyHeading = (line: string) => /^#{1,6}\s+graphify\s*$/i.test(line);

describe("removeHeadingSection", () => {
  test("removes the section up to the next heading and collapses blank runs", () => {
    const content = [
      "# Intro",
      "",
      "Keep this.",
      "",
      "## graphify",
      "",
      "Managed body.",
      "",
      "## After",
      "",
      "Also kept.",
      "",
    ].join("\n");

    expect(removeHeadingSection(content, { isHeading: isGraphifyHeading })).toBe(
      ["# Intro", "", "Keep this.", "", "## After", "", "Also kept.", ""].join("\n"),
    );
  });

  test("strips marker lines even when no section heading remains", () => {
    const content = ["<!-- START -->", "# Intro", "<!-- END -->", ""].join("\n");

    expect(
      removeHeadingSection(content, {
        isHeading: isGraphifyHeading,
        markerLines: ["<!-- START -->", "<!-- END -->"],
      }),
    ).toBe("# Intro\n");
  });

  test("returns content unchanged when nothing matches", () => {
    const content = "# Intro\n\nBody.\n";
    expect(removeHeadingSection(content, { isHeading: isGraphifyHeading })).toBe(content);
  });

  test("returns empty string when the section is the whole document", () => {
    const content = "## graphify\n\nOnly managed content.\n";
    expect(removeHeadingSection(content, { isHeading: isGraphifyHeading })).toBe("");
  });
});

describe("cutFromMarker", () => {
  test("returns content unchanged when the marker is absent", () => {
    expect(cutFromMarker("# Intro\n", "## MARKER")).toBe("# Intro\n");
  });

  test("cuts from the marker to EOF and trims trailing whitespace", () => {
    expect(cutFromMarker("# Intro\n\nBody.\n\n## MARKER\n\nAppended.\n", "## MARKER")).toBe(
      "# Intro\n\nBody.\n",
    );
  });

  test("returns empty string when only the marker block existed", () => {
    expect(cutFromMarker("## MARKER\n\nAppended.\n", "## MARKER")).toBe("");
  });
});
