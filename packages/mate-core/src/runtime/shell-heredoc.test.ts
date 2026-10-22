import { describe, expect, test } from "bun:test";

import { heredocBodies, stripHeredocBodies } from "./shell-heredoc";

describe("stripHeredocBodies", () => {
  test("drops the body and terminator, keeping the marker line", () => {
    expect(stripHeredocBodies("cat <<'EOF' > note.md\nsee > x.md\nEOF\nls")).toBe(
      "cat <<'EOF' > note.md\nls",
    );
  });

  test("ends an indented <<- body at its tab-indented terminator", () => {
    expect(stripHeredocBodies("cat <<-END\n\tbody\n\tEND\necho done")).toBe(
      "cat <<-END\necho done",
    );
  });

  test("drops consecutive bodies of several markers on one line", () => {
    expect(stripHeredocBodies('cat <<A <<"B"\na\nA\nb\nB\nls')).toBe('cat <<A <<"B"\nls');
  });

  test("ignores a marker inside quotes and a here-string", () => {
    const command = "git commit -m 'see <<EOF'\ncat <<< word\necho x > a.md";
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("drops an unterminated body to the end", () => {
    expect(stripHeredocBodies("cat <<EOF\nbody > x.md")).toBe("cat <<EOF");
  });
});

describe("heredocBodies", () => {
  test("returns each body without its marker or terminator", () => {
    expect(heredocBodies('cat <<A <<"B"\na1\na2\nA\nb\nB\nls')).toEqual([
      { line: 0, text: "a1\na2" },
      { line: 0, text: "b" },
    ]);
  });

  test("returns an unterminated body to the end", () => {
    expect(heredocBodies("cat <<EOF\nbody")).toEqual([{ line: 0, text: "body" }]);
  });

  test("records the stripped-command line of each marker", () => {
    expect(heredocBodies("ls\ncat <<A\na\nA\ncat <<B\nb\nB").map((body) => body.line)).toEqual([
      1, 2,
    ]);
  });

  test("returns nothing for a marker inside quotes", () => {
    expect(heredocBodies("git commit -m 'see <<EOF'\nls")).toEqual([]);
  });
});
