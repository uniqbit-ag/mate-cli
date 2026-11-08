import { expect, test } from "bun:test";

import { resolveRtkDatabase } from "./rtk-database";

test("RTK defaults follow macOS, Linux/XDG and Windows platform directories", async () => {
  for (const [platform, home, env, expected, config] of [
    [
      "darwin",
      "/acme/home",
      { XDG_DATA_HOME: "/acme/ignored" },
      "/acme/home/Library/Application Support/rtk/history.db",
      "/acme/home/Library/Application Support/rtk/config.toml",
    ],
    [
      "linux",
      "/acme/home",
      {},
      "/acme/home/.local/share/rtk/history.db",
      "/acme/home/.config/rtk/config.toml",
    ],
    [
      "linux",
      "/acme/home",
      { XDG_DATA_HOME: "/acme/data", XDG_CONFIG_HOME: "/acme/config" },
      "/acme/data/rtk/history.db",
      "/acme/config/rtk/config.toml",
    ],
    [
      "win32",
      "C:\\acme",
      { LOCALAPPDATA: "C:\\acme\\local", APPDATA: "C:\\acme\\roaming" },
      "C:\\acme\\local\\rtk\\history.db",
      "C:\\acme\\roaming\\rtk\\config.toml",
    ],
  ] as const) {
    let asked = "";
    expect(
      await resolveRtkDatabase({
        platform,
        home,
        env,
        readConfig: async (file) => {
          asked = file;
          return "";
        },
      }),
    ).toBe(expected);
    expect(asked).toBe(config);
  }
});

test("RTK environment path wins without reading config; TOML tracking override wins over defaults", async () => {
  expect(
    await resolveRtkDatabase({
      env: { RTK_DB_PATH: "/acme/override.db" },
      readConfig: async () => {
        throw new Error("must not read");
      },
    }),
  ).toBe("/acme/override.db");
  expect(
    await resolveRtkDatabase({
      platform: "darwin",
      home: "/acme/home",
      env: {},
      readConfig: async () => '[tracking]\ndatabase_path = "/acme/custom ledger.db"\n',
    }),
  ).toBe("/acme/custom ledger.db");
  expect(
    await resolveRtkDatabase({
      platform: "win32",
      home: "C:\\acme",
      env: {},
      readConfig: async () => "[tracking]\ndatabase_path = 'C:\\acme\\custom.db'\n",
    }),
  ).toBe("C:\\acme\\custom.db");
});

test("invalid RTK config is not silently replaced by another ledger", async () => {
  for (const config of [
    "[tracking",
    "[tracking]\ndatabase_path = 42",
    '[tracking]\ndatabase_path = ""',
  ]) {
    await expect(resolveRtkDatabase({ env: {}, readConfig: async () => config })).rejects.toThrow();
  }
});
