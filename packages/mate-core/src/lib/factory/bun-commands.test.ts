import { describe, expect, test } from "bun:test";

import { BAKED_BRIDGE_DIR, bunCommand } from "./bun-commands";

const linkOrInstall = (frozen: string) =>
  `if cmp -s package.json ${BAKED_BRIDGE_DIR}/package.json && test -d ${BAKED_BRIDGE_DIR}/node_modules; ` +
  `then ln -sfn ${BAKED_BRIDGE_DIR}/node_modules node_modules; ` +
  `else bun install${frozen}; fi`;

describe("bunCommand", () => {
  test.each([
    ["pnpm install --frozen-lockfile --store-dir .pnpm-store", linkOrInstall(" --frozen-lockfile")],
    ["pnpm i", linkOrInstall("")],
    ["npm install", linkOrInstall("")],
    ["npm ci", linkOrInstall(" --frozen-lockfile")],
    ["yarn install --frozen-lockfile", linkOrInstall(" --frozen-lockfile")],
  ])("installs with Bun: %s", (command, expected) => {
    expect(bunCommand(command)).toBe(expected);
  });

  test.each([
    ["pnpm run build", "bun run build"],
    ["npm run test -- --watch", "bun run test -- --watch"],
    ["pnpm exec tsc --noEmit", "bunx tsc --noEmit"],
    ["pnpm dlx cowsay hi", "bunx cowsay hi"],
    ["npx acme-cli --flag", "bunx acme-cli --flag"],
    [
      "node '/home/mate/.harness-bootstrap/claude-code/bridge.mjs' --workdir '/w'",
      "bun '/home/mate/.harness-bootstrap/claude-code/bridge.mjs' --workdir '/w'",
    ],
  ])("runs with Bun: %s", (command, expected) => {
    expect(bunCommand(command)).toBe(expected);
  });

  test.each([
    "./node_modules/.bin/claude --version",
    'mkdir -p "$BOOTSTRAP_DIR"',
    "git status",
    "nodemon src",
    "pnpmx install",
    "bun install",
  ])("leaves other commands alone: %s", (command) => {
    expect(bunCommand(command)).toBe(command);
  });
});
