import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { batchLabel, companionFile, readFiles, runsOf, sentMessages } from "./chat-text";

const text = (id: string, role: UIMessage["role"], value: string): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text: value }],
});

describe("sentMessages", () => {
  test("sends text parts only and drops a message left with none", () => {
    const answer: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-read",
          toolCallId: "c1",
          state: "output-available",
          input: { path: "specs/acme/spec.md" },
          output: "x".repeat(50_000),
        },
        { type: "text", text: "Two capabilities." },
      ],
    };
    const toolsOnly: UIMessage = { ...answer, id: "a2", parts: [answer.parts[0]!] };
    const sent = sentMessages([
      text("u1", "user", "Which?"),
      answer,
      toolsOnly,
      text("u2", "user", "More?"),
    ]);
    expect(sent.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
    expect(sent[1]!.parts).toEqual([{ type: "text", text: "Two capabilities." }]);
  });

  test("keeps the newest messages of a long conversation", () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      text(`m${index}`, index % 2 ? "assistant" : "user", "a few words"),
    );
    const sent = sentMessages(many);
    expect(sent).toHaveLength(40);
    expect(sent.at(-1)!.id).toBe("m119");

    const long = [
      text("u1", "user", "x".repeat(60_000)),
      text("a1", "assistant", "y".repeat(10_000)),
      text("u2", "user", "Next?"),
    ];
    expect(sentMessages(long).map((message) => message.id)).toEqual(["a1", "u2"]);
  });

  test("always sends the new question, however long", () => {
    const sent = sentMessages([text("u1", "user", "x".repeat(100_000))]);
    expect(sent.map((message) => message.id)).toEqual(["u1"]);
  });
});

describe("companionFile and readFiles", () => {
  const root = "/home/dev/.mate/companions/acme";

  test("names a file inside the companion and nothing outside it", () => {
    expect(companionFile(`${root}/openspec/specs/acme/spec.md`, [root])).toBe(
      "openspec/specs/acme/spec.md",
    );
    expect(companionFile("./AGENTS.md", [root])).toBe("AGENTS.md");
    expect(companionFile("/etc/hosts", [root])).toBeNull();
    expect(companionFile(`${root}-other/AGENTS.md`, [root])).toBeNull();
    expect(companionFile("docs/../../secret", [root])).toBeNull();
    expect(companionFile(`${root}/AGENTS.md`, [])).toBeNull();
    // The agent may report the path with links followed.
    expect(companionFile("/private/tmp/acme/AGENTS.md", ["/tmp/acme", "/private/tmp/acme"])).toBe(
      "AGENTS.md",
    );
  });

  test("lists the files an answer read, once each, skipping failed reads", () => {
    const read = (id: string, file: string, state: "output-available" | "output-error") =>
      ({
        type: "tool-read",
        toolCallId: id,
        state,
        input: { file_path: file },
        ...(state === "output-available" ? { output: "…" } : { errorText: "missing" }),
      }) as UIMessage["parts"][number];
    const answer: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        read("t1", `${root}/AGENTS.md`, "output-available"),
        read("t2", `${root}/AGENTS.md`, "output-available"),
        read("t3", `${root}/missing.md`, "output-error"),
        read("t4", "/etc/hosts", "output-available"),
      ],
    };
    expect(readFiles(answer, [root])).toEqual(["AGENTS.md"]);
  });
});

describe("runsOf", () => {
  test("cuts consecutive items with the same key into runs, in order", () => {
    expect(runsOf(["read", "read", "grep", "read"], (name) => name)).toEqual([
      ["read", "read"],
      ["grep"],
      ["read"],
    ]);
    expect(runsOf([], (name: string) => name)).toEqual([]);
  });
});

describe("batchLabel", () => {
  test("names what a batch of one tool did", () => {
    expect(batchLabel("read", 4)).toBe("Read 4 files");
    expect(batchLabel("grep", 2)).toBe("Searched 2 patterns");
    expect(batchLabel("glob", 3)).toBe("Listed 3 file patterns");
    expect(batchLabel("Skill", 2)).toBe("Skill ×2");
  });
});
