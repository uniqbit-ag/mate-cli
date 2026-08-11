import { afterEach, describe, expect, mock, test } from "bun:test";

import { buildPairingSnapshot } from "./pairing-snapshot";
import { createVscodeMock } from "./test-support/vscode-mock";

afterEach(() => {
  mock.restore();
});

const READY_PAIRING = {
  companionPath: "/companions/a",
  repository: { id: "app", path: "/repos/app" },
  health: "ready" as const,
  ambiguous: false,
};
const DRIFT_PAIRING = {
  companionPath: "/companions/b",
  repository: { id: "other", path: "/repos/other" },
  health: "unreadable" as const,
  ambiguous: false,
};

const SNAPSHOT = buildPairingSnapshot({
  schemaVersion: 1,
  companions: [
    { path: "/companions/a", health: "ready" },
    { path: "/companions/b", health: "unreadable" },
  ],
  pairings: [READY_PAIRING, DRIFT_PAIRING],
});

async function load() {
  return import("./status-bar");
}

describe("resolvePairingPresence", () => {
  test("returns paired when a folder matches a healthy pairing's working-repository root", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { resolvePairingPresence } = await load();

    expect(resolvePairingPresence(["/repos/app"], SNAPSHOT)).toEqual({
      state: "paired",
      pairing: READY_PAIRING,
    });
  });

  test("returns paired when a folder matches the companion root instead of the working repository", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { resolvePairingPresence } = await load();

    expect(resolvePairingPresence(["/companions/a"], SNAPSHOT)).toEqual({
      state: "paired",
      pairing: READY_PAIRING,
    });
  });

  test("returns drift when a folder matches a pairing reporting a health issue", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { resolvePairingPresence } = await load();

    expect(resolvePairingPresence(["/repos/other"], SNAPSHOT)).toEqual({
      state: "drift",
      pairing: DRIFT_PAIRING,
    });
  });

  test("returns unpaired when no folder matches any pairing", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { resolvePairingPresence } = await load();

    expect(resolvePairingPresence(["/somewhere/else"], SNAPSHOT)).toEqual({ state: "unpaired" });
  });

  test("checks every folder in a multi-root window, not just the first", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { resolvePairingPresence } = await load();

    expect(resolvePairingPresence(["/somewhere/else", "/repos/app"], SNAPSHOT)).toEqual({
      state: "paired",
      pairing: READY_PAIRING,
    });
  });

  test("does not match a subdirectory of a working repository root", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { resolvePairingPresence } = await load();

    expect(resolvePairingPresence(["/repos/app/src"], SNAPSHOT)).toEqual({ state: "unpaired" });
  });
});

describe("MateStatusBarItem", () => {
  test("clicking while paired reveals the matched pairing", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { MateStatusBarItem } = await load();
    const revealed: unknown[] = [];

    const statusBar = new MateStatusBarItem({
      getState: () => ({ status: "ready", snapshot: SNAPSHOT }),
      getWorkspaceFolderPaths: () => ["/repos/app"],
      revealPairing: (pairing) => revealed.push(pairing),
    });
    statusBar.render();
    statusBar.handleClick();

    expect(revealed).toEqual([READY_PAIRING]);
  });

  test("clicking while unpaired shows guidance instead of revealing anything", async () => {
    const { module, calls } = createVscodeMock();
    mock.module("vscode", () => module);
    const { MateStatusBarItem } = await load();
    const revealed: unknown[] = [];

    const statusBar = new MateStatusBarItem({
      getState: () => ({ status: "ready", snapshot: SNAPSHOT }),
      getWorkspaceFolderPaths: () => ["/nowhere"],
      revealPairing: (pairing) => revealed.push(pairing),
    });
    statusBar.handleClick();

    expect(revealed).toEqual([]);
    expect(calls.showInformationMessage).toHaveLength(1);
  });
});
