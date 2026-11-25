import { describe, expect, test } from "bun:test";

import { quoteCommandArg } from "./command-arg";

describe("quoteCommandArg", () => {
  test("leaves a plain word bare", () => {
    expect(quoteCommandArg("refusal:artifact:write")).toBe("refusal:artifact:write");
  });

  test("double-quotes text with a space, which every shell keeps as one argument", () => {
    expect(quoteCommandArg("command:artifact submit:1")).toBe('"command:artifact submit:1"');
  });

  test("single-quotes text a double-quoting shell would expand", () => {
    expect(quoteCommandArg("command:it's $HOME:1")).toBe(`'command:it'\\''s $HOME:1'`);
  });
});
