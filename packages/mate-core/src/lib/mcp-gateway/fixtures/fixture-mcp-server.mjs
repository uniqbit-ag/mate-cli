#!/usr/bin/env node
/**
 * Test fixture: minimal stdio MCP server.
 * Env knobs:
 *   FIXTURE_TOOLS       JSON array of tool names (default ["alpha"])
 *   FIXTURE_SPAWN_LOG   file to append this process pid to on start
 *   FIXTURE_EXIT_AFTER_INIT  exit(1) right after the initialize handshake
 *   FIXTURE_CRASH_ONCE_FILE  crash on first tools/call (marker file arms once)
 *   FIXTURE_FAIL_TOOL   tool name whose call returns a JSON-RPC error
 */
import fs from "node:fs";

const tools = JSON.parse(process.env.FIXTURE_TOOLS ?? '["alpha"]').map((name) => ({
  name,
  description: `fixture tool ${name}`,
  inputSchema: { type: "object", properties: {} },
}));

if (process.env.FIXTURE_SPAWN_LOG) {
  fs.appendFileSync(process.env.FIXTURE_SPAWN_LOG, `${process.pid}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "0.0.1" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    if (process.env.FIXTURE_EXIT_AFTER_INIT) process.exit(1);
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    const crashFile = process.env.FIXTURE_CRASH_ONCE_FILE;
    if (crashFile && !fs.existsSync(crashFile)) {
      fs.writeFileSync(crashFile, "armed");
      process.exit(1);
    }
    const name = message.params?.name;
    if (name === process.env.FIXTURE_FAIL_TOOL) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: `fixture failure for ${name}` },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: `${name}:${process.pid}` }] },
    });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
  }
}
