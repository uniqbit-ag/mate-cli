import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { cutFromMarker, removeHeadingSection, stripSectionFromFile } from "./agent-file-sections";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

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

describe("stripSectionFromFile", () => {
  async function fileOf(content: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acme-agent-file-"));
    tempRoots.push(dir);
    const file = path.join(dir, "AGENTS.md");
    await fs.writeFile(file, content, "utf8");
    return { dir, file };
  }

  test("a strip that empties a symlinked file keeps the link and empties its target", async () => {
    const { dir, file } = await fileOf("## graphify\n\nOnly managed content.\n");
    const link = path.join(dir, "LINKED.md");
    await fs.symlink(file, link);

    await stripSectionFromFile(link, { isHeading: isGraphifyHeading });

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("");
  });

  test("a strip that empties a plain file deletes it", async () => {
    const { file } = await fileOf("## graphify\n\nOnly managed content.\n");

    await stripSectionFromFile(file, { isHeading: isGraphifyHeading });

    expect(await fs.stat(file).catch(() => null)).toBeNull();
  });
});
