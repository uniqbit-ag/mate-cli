import { describe, expect, test } from "bun:test";

import { stripHeredocBodies } from "./shell-heredoc";

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
