import { describe, expect, test } from "bun:test";

import { heredocBodies, heredocMarker, stripHeredocBodies } from "./shell-heredoc";

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

  test("ignores a marker inside an ANSI-C string with an escaped quote", () => {
    const command = "echo $'x\\' <<EOF'\ncat .env\nEOF";
    expect(stripHeredocBodies(command)).toBe(command);
    expect(stripHeredocBodies("echo $'x\\'' <<EOF\nbody\nEOF\nls")).toBe("echo $'x\\'' <<EOF\nls");
  });

  test("drops an unterminated body to the end", () => {
    expect(stripHeredocBodies("cat <<EOF\nbody > x.md")).toBe("cat <<EOF");
  });

  test("the delimiter is the whole word after quote removal, as Bash takes it", () => {
    expect(stripHeredocBodies('cat <<E"OF"\nbody\nEOF\ncat cert.key')).toBe(
      'cat <<E"OF"\ncat cert.key',
    );
    expect(stripHeredocBodies("cat <<EOF+\nbody\nEOF+\ncat cert.key")).toBe(
      "cat <<EOF+\ncat cert.key",
    );
    expect(stripHeredocBodies("cat <<'E'OF\\!\nbody\nEOF!\nls")).toBe("cat <<'E'OF\\!\nls");
    expect(stripHeredocBodies("cat <<EOF;echo x\nbody\nEOF\nls")).toBe("cat <<EOF;echo x\nls");
  });

  test("a delimiter the reader cannot settle strips nothing", () => {
    for (const command of [
      "cat <<$(echo EOF)\nbody\nEOF\ncat cert.key",
      "cat <<$EOF\nbody\n$EOF\ncat cert.key",
      "cat <<`echo EOF`\nbody\nEOF\ncat cert.key",
      "cat <<\ncat cert.key",
      "cat <<'EOF\nbody\nEOF\ncat cert.key",
    ]) {
      expect(stripHeredocBodies(command)).toBe(command);
    }
  });

  test("a marker inside a quote that spans lines opens no heredoc", () => {
    const command = "printf '%s' '\n<<EOF\n'\ncat cert.key";
    expect(stripHeredocBodies(command)).toBe(command);
    const double = 'printf "%s" "\n<<EOF\n"\ncat cert.key';
    expect(stripHeredocBodies(double)).toBe(double);
  });

  test("a marker that reads unquoted only in the whole command strips nothing", () => {
    // Bash opens this heredoc, but the line on its own starts inside a quote.
    const command = "echo 'a\nb' <<EOF\nbody\nEOF\ncat cert.key";
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("a quote nested in a parameter expansion stays open across lines", () => {
    for (const command of [
      'echo "${x:-"\n<<EOF\n"}"\ncat cert.key',
      "echo ${x:-<<EOF}\ncat cert.key",
      "echo ${x:-'\n<<EOF\n'}\ncat cert.key",
    ]) {
      expect(stripHeredocBodies(command)).toBe(command);
    }
    expect(stripHeredocBodies('echo "${x:-a}" <<EOF\nbody\nEOF\nls')).toBe(
      'echo "${x:-a}" <<EOF\nls',
    );
  });

  test("a shift in arithmetic opens no heredoc", () => {
    for (const command of [
      "echo $((1<<2))\ncat cert.key",
      "((x <<= 1))\ncat cert.key",
      "echo $[1<<2]\ncat cert.key",
    ]) {
      expect(stripHeredocBodies(command)).toBe(command);
    }
  });

  test("a heredoc inside a quoted command substitution is a heredoc", () => {
    expect(
      stripHeredocBodies(`git commit -m "$(cat <<'EOF'\nfix: x\n\nsee .env\nEOF\n)"\nls`),
    ).toBe(`git commit -m "$(cat <<'EOF'\n)"\nls`);
  });

  test("the body starts after the line where a quote opened on the marker line closes", () => {
    expect(stripHeredocBodies("cat <<EOF; echo 'a\nb'\nbody\nEOF\nls")).toBe(
      "cat <<EOF; echo 'a\nb'\nls",
    );
  });

  test("a line continuation moves the body below the next line", () => {
    expect(stripHeredocBodies("cat <<EOF \\\n> out.txt\nbody\nEOF\nls")).toBe(
      "cat <<EOF \\\n> out.txt\nls",
    );
  });
});

describe("heredocMarker", () => {
  test("ends at the marker word and names its delimiter", () => {
    expect(heredocMarker("cat <<-  'EOF' > x", 4)).toEqual({ end: 14, delimiter: "EOF" });
    expect(heredocMarker('<<E"OF"', 0)).toEqual({ end: 7, delimiter: "EOF" });
    expect(heredocMarker("<<EOF+|x", 0)).toEqual({ end: 6, delimiter: "EOF+" });
    expect(heredocMarker("<<\\EOF", 0)).toEqual({ end: 6, delimiter: "EOF" });
  });

  test("names no delimiter when it holds an expansion or nothing", () => {
    expect(heredocMarker("<<$(x)", 0).delimiter).toBeNull();
    expect(heredocMarker('<<"$X"', 0).delimiter).toBeNull();
    expect(heredocMarker("<<$'EOF'", 0).delimiter).toBeNull();
    expect(heredocMarker("<< ;", 0).delimiter).toBeNull();
    expect(heredocMarker("<<'EOF", 0).delimiter).toBeNull();
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

  test("records a body inside a substitution on the line that opened it", () => {
    expect(heredocBodies(`git commit -m "$(cat <<'EOF'\nmsg\nEOF\n)"`)).toEqual([
      { line: 0, text: "msg" },
    ]);
  });
});
