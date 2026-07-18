import { describe, expect, test } from "bun:test";

import { parseRepoLinkInput } from "./wizard-key-input";

describe("parseRepoLinkInput", () => {
  describe("shared keys (text and select mode)", () => {
    for (const mode of ["text", "select"] as const) {
      test(`Enter submits in ${mode} mode`, () => {
        expect(parseRepoLinkInput("\r", mode)).toEqual({ action: "submit" });
        expect(parseRepoLinkInput("\n", mode)).toEqual({ action: "submit" });
      });

      test(`left arrow backs in ${mode} mode`, () => {
        expect(parseRepoLinkInput("[D", mode)).toEqual({ action: "back" });
        expect(parseRepoLinkInput("[D", mode)).toEqual({ action: "back" });
      });

      test(`Escape and q cancel in ${mode} mode`, () => {
        expect(parseRepoLinkInput("\x1b", mode)).toEqual({ action: "cancel" });
        expect(parseRepoLinkInput("q", mode)).toEqual({ action: "cancel" });
        expect(parseRepoLinkInput("Q", mode)).toEqual({ action: "cancel" });
      });
    }
  });

  describe("text mode", () => {
    test("printable characters return char action", () => {
      expect(parseRepoLinkInput("a", "text")).toEqual({ action: "char", char: "a" });
      expect(parseRepoLinkInput("Z", "text")).toEqual({ action: "char", char: "Z" });
      expect(parseRepoLinkInput("/", "text")).toEqual({ action: "char", char: "/" });
      expect(parseRepoLinkInput("-", "text")).toEqual({ action: "char", char: "-" });
    });

    test("backspace (DEL and \\b) returns backspace action", () => {
      expect(parseRepoLinkInput("\x7f", "text")).toEqual({ action: "backspace" });
      expect(parseRepoLinkInput("\b", "text")).toEqual({ action: "backspace" });
    });

    test("up and down arrows are ignored in text mode", () => {
      expect(parseRepoLinkInput("[A", "text")).toBeNull();
      expect(parseRepoLinkInput("[B", "text")).toBeNull();
      expect(parseRepoLinkInput("[A", "text")).toBeNull();
      expect(parseRepoLinkInput("[B", "text")).toBeNull();
    });

    test("unrecognized sequences return null", () => {
      expect(parseRepoLinkInput("[C", "text")).toBeNull();
      expect(parseRepoLinkInput("\x00", "text")).toBeNull();
    });
  });

  describe("select mode", () => {
    test("up and down arrows navigate", () => {
      expect(parseRepoLinkInput("[A", "select")).toEqual({ action: "up" });
      expect(parseRepoLinkInput("[B", "select")).toEqual({ action: "down" });
      expect(parseRepoLinkInput("[A", "select")).toEqual({ action: "up" });
      expect(parseRepoLinkInput("[B", "select")).toEqual({ action: "down" });
    });

    test("printable characters are ignored in select mode", () => {
      expect(parseRepoLinkInput("a", "select")).toBeNull();
      expect(parseRepoLinkInput(" ", "select")).toBeNull();
    });
  });
});
