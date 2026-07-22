#!/usr/bin/env bun
import { createMate } from "@uniqbit/mate-core";
import {
  createClaudePlugin,
  createGraphifyPlugin,
  createHeadroomPlugin,
  createOpenCodePlugin,
  createOpenspecPlugin,
  createReactDoctorPlugin,
  createTokensavePlugin,
} from "@uniqbit/mate-core/plugins";

import { version } from "../package.json";
import { createContext7Plugin } from "./plugins/context7";

const claude = createClaudePlugin();
const opencode = createOpenCodePlugin();

const openspec = createOpenspecPlugin();
const reactDoctor = createReactDoctorPlugin();
const tokensave = createTokensavePlugin();
const headroom = createHeadroomPlugin();
const graphify = createGraphifyPlugin();
const context7 = createContext7Plugin();

const cli = createMate({
  config: {
    name: "mate",
    runtime: "bun",
    version,
  },
  plugins: [
    { plugin: opencode, policy: "required" },
    { plugin: claude, policy: "optional" },
    { plugin: openspec, policy: "required" },
    { plugin: reactDoctor, policy: "optional" },
    { plugin: tokensave, policy: "optional" },
    { plugin: headroom, policy: "optional" },
    { plugin: graphify, policy: "optional" },
    { plugin: context7, policy: "optional" },
  ],
});

cli.run();
