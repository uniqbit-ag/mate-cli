import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CHAT_HARNESSES, CHAT_MODELS, type ChatHarness } from "./agent";
import { loadAdapter, loadHarness } from "./harness-chat-agent";
import { createHostSandbox } from "./host-sandbox";

/**
 * Installs the bridge of each harness the chat offers into `destination`, for Studio to use
 * without installing (`MATE_STUDIO_CHAT_BRIDGES`). Each harness's own bootstrap runs through the
 * chat's sandbox, so the bridge carries its guards and the marker a turn checks; the appliance's
 * image runs this at build time:
 *
 *   bun prepare-bridges.ts <destination>
 *   bun prepare-bridges.ts --check <destination>
 */
export async function prepareChatBridges(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const { createHarnessSandboxTemplate } = await import("@ai-sdk/harness/agent");
  // An empty companion: preparing reads nothing of one.
  const workDir = await mkdtemp(path.join(os.tmpdir(), "mate-chat-bridges-"));
  try {
    const sandbox = await createHostSandbox({ workDir, bootstrapCache: destination });
    try {
      for (const harness of CHAT_HARNESSES) {
        // oxlint-disable-next-line no-await-in-loop -- one install at a time.
        const adapter = (await loadAdapter(harness))({
          port: sandbox.port,
          model: CHAT_MODELS[harness][0]!.id,
        });
        // oxlint-disable-next-line no-await-in-loop -- one install at a time.
        const template = await createHarnessSandboxTemplate({ harnesses: [adapter as never] });
        // oxlint-disable-next-line no-await-in-loop -- one install at a time.
        await template?.prepare({ session: sandbox.restricted() });
        // oxlint-disable-next-line no-await-in-loop -- one install at a time.
        await PRUNE[harness]?.(path.join(destination, harness));
      }
    } finally {
      await sandbox.stop();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Starts a session of each offered harness from the prebuilt bridges in `directory`, as a chat
 * turn would, and stops it before any prompt. Rejects when a bridge is missing or incomplete,
 * that is when the turn would have had to install or change it.
 */
export async function checkChatBridges(directory: string): Promise<void> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "mate-chat-bridges-"));
  try {
    for (const harness of CHAT_HARNESSES) {
      // oxlint-disable-next-line no-await-in-loop -- one bridge at a time.
      const sandbox = await createHostSandbox({ workDir, prebuiltBridges: directory });
      try {
        // oxlint-disable-next-line no-await-in-loop -- one bridge at a time.
        const modules = await loadHarness(harness);
        const agent = modules.createAgent({ port: sandbox.port, instructions: "", skills: [] });
        const signal = new AbortController().signal;
        // oxlint-disable-next-line no-await-in-loop -- one bridge at a time.
        const session = await agent.createSession({ sandboxSession: sandbox, abortSignal: signal });
        // oxlint-disable-next-line no-await-in-loop -- one bridge at a time.
        await session.stop();
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- one bridge at a time.
        await sandbox.stop();
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Drops what a harness's install holds for other platforms; the bridge never runs it. */
const PRUNE: Partial<Record<ChatHarness, (bridge: string) => Promise<void>>> = {
  // The bridge runs only the Agent SDK's binary for this platform. Every other Claude native
  // package (the CLI's, another libc's) is hundreds of MB the image would carry for nothing.
  "claude-code": async (bridge) => {
    const scope = path.join(bridge, "node_modules", "@anthropic-ai");
    const keep = `claude-agent-sdk-${process.platform}-${process.arch}`;
    const native = /^claude-(?:code|agent-sdk)-/;
    for (const name of await readdir(scope)) {
      if (native.test(name) && name !== keep) {
        // oxlint-disable-next-line no-await-in-loop -- a handful of directories.
        await rm(path.join(scope, name), { recursive: true, force: true });
      }
    }
    // The bootstrap's version check runs `.bin/claude`; it now names the SDK's binary.
    const bin = path.join(bridge, "node_modules", ".bin", "claude");
    await rm(bin, { force: true });
    await symlink(path.join("..", "@anthropic-ai", keep, "claude"), bin);
  },
};

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  const check = first === "--check";
  const directory = check ? second : first;
  if (!directory) {
    console.error("usage: bun prepare-bridges.ts [--check] <directory>");
    process.exit(2);
  }
  if (check) {
    await checkChatBridges(path.resolve(directory));
    console.log(`the chat bridges in ${directory} start without installing`);
  } else {
    await prepareChatBridges(path.resolve(directory));
    console.log(`prepared the chat bridges in ${directory}`);
  }
}
