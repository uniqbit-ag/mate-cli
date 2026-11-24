import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CREDENTIAL_NAMES,
  companionReadGuard,
  createHostSandbox,
  hostCommand,
  loopbackBridge,
  openCodeToolsOff,
  userSettingsOnly,
  type HostSandbox,
} from "./host-sandbox";

/** A file of a pinned harness package, as installed. */
async function harnessFile(pkg: string, file: string): Promise<string> {
  const entry = Bun.resolveSync(pkg, import.meta.dir);
  return fs.readFile(path.join(path.dirname(entry), "..", file), "utf8");
}

let root: string;
let companion: string;
let cache: string;
let sandbox: HostSandbox | null = null;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mate-host-sandbox-")));
  companion = path.join(root, "acme");
  cache = path.join(root, "cache");
  await fs.mkdir(companion);
  await fs.writeFile(path.join(companion, "AGENTS.md"), "# Acme\n");
});

afterEach(async () => {
  await sandbox?.stop();
  sandbox = null;
  await fs.rm(root, { recursive: true, force: true });
});

async function open(env: NodeJS.ProcessEnv = { PATH: process.env.PATH }): Promise<HostSandbox> {
  sandbox = await createHostSandbox({ workDir: companion, bootstrapCache: cache, env });
  return sandbox;
}

describe("hostCommand", () => {
  test("runs the bootstrap's package installs and Node scripts with Bun", () => {
    expect(hostCommand("pnpm install --frozen-lockfile --store-dir .pnpm-store")).toBe(
      "bun install --frozen-lockfile",
    );
    expect(hostCommand("node '/x/bridge.mjs' --workdir '/w'")).toBe(
      "bun '/x/bridge.mjs' --workdir '/w'",
    );
    expect(hostCommand("./node_modules/.bin/claude --version")).toBe(
      "./node_modules/.bin/claude --version",
    );
  });

  test("leaves an install that names packages or chains commands as it is", () => {
    for (const command of [
      "pnpm install @anthropic-ai/claude-code@1.2",
      "npm install --prefix /x && node setup.mjs",
      "yarn install; echo done",
      "npm install --prefix /x",
      "pnpm install --dir acme",
      "pnpm install --no-frozen-lockfile",
    ]) {
      expect(hostCommand(command)).toBe(command);
    }
  });
});

test("loopbackBridge binds the bridge to loopback", () => {
  expect(loopbackBridge('new WebSocketServer({ port, host: "0.0.0.0" })')).toBe(
    'new WebSocketServer({ port, host: "127.0.0.1" })',
  );
});

test("CREDENTIAL_NAMES holds every credential either pinned harness reads", async () => {
  const listed = (source: string, name: string) => {
    const block = new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(source)?.[1] ?? "";
    return [...block.matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1]!);
  };
  const openCode = await harnessFile("@ai-sdk/harness-opencode", "src/opencode-auth.ts");
  const claudeCode = await harnessFile("@ai-sdk/harness-claude-code", "src/claude-code-auth.ts");
  const names = [
    ...listed(openCode, "OPENCODE_CREDENTIAL_ENVIRONMENT_VARIABLES"),
    ...listed(claudeCode, "CLAUDE_CODE_CREDENTIAL_ENVIRONMENT_VARIABLES"),
    // Named by constant in OpenCode's list.
    /OPENCODE_SUBSCRIPTION_ACCESS_TOKEN_ENVIRONMENT_VARIABLE =\s*'([A-Z_]+)'/.exec(openCode)![1]!,
  ];
  expect(names.length).toBeGreaterThan(10);
  expect(names.filter((name) => !CREDENTIAL_NAMES.has(name))).toEqual([]);
});

describe("openCodeToolsOff", () => {
  test("denies fetching, web search, subagents and todos in the pinned OpenCode bridge, which still parses", async () => {
    const bridge = await harnessFile("@ai-sdk/harness-opencode", "dist/bridge/index.mjs");
    expect(loopbackBridge(bridge)).not.toBe(bridge);
    const guarded = openCodeToolsOff(loopbackBridge(bridge));
    expect(guarded).not.toContain('webfetch: "ask"');
    expect(guarded).not.toContain('task: "ask"');
    for (const tool of ["webfetch", "websearch", "codesearch", "todowrite", "task"]) {
      expect(guarded).toContain(`${tool}: "deny"`);
    }
    expect(openCodeToolsOff(guarded)).toBe(guarded);
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(guarded)).not.toThrow();
  });
});

type ReadHook = (input: { tool_name: string; tool_input: Record<string, unknown> }) => Promise<{
  hookSpecificOutput?: { permissionDecision: string };
}>;

/** The guard as the bridge runs it, with `workdir` the companion. */
function readGuard(workdir: string): ReadHook {
  const source = companionReadGuard(
    'const hooks = { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [] }] };',
  );
  // oxlint-disable-next-line no-new-func -- runs the injected bridge source as the bridge would.
  const hooks = new Function("workdir", `${source}\nreturn hooks;`)(workdir) as {
    PreToolUse: { matcher: string; hooks: ReadHook[] }[];
  };
  expect(hooks.PreToolUse.map((entry) => entry.matcher)).toEqual([
    "Read|Grep|Glob|NotebookRead|LS",
    "AskUserQuestion",
  ]);
  return hooks.PreToolUse[0]!.hooks[0]!;
}

describe("companionReadGuard", () => {
  test("denies reads that leave the companion, links followed, and allows the rest", async () => {
    await fs.writeFile(path.join(root, "secret.txt"), "acme-secret");
    await fs.mkdir(path.join(companion, "docs"));
    let hook = readGuard(companion);
    const denied = async (tool_name: string, tool_input: Record<string, unknown>) =>
      (await hook({ tool_name, tool_input })).hookSpecificOutput?.permissionDecision === "deny";

    expect(await denied("Read", { file_path: "AGENTS.md" })).toBe(false);
    expect(await denied("Read", { file_path: path.join(companion, "missing", "x.md") })).toBe(
      false,
    );
    expect(await denied("Grep", { pattern: "acme" })).toBe(false);
    expect(await denied("Glob", { pattern: "openspec/**/*.md" })).toBe(false);
    await fs.symlink(path.join(root, "secret.txt"), path.join(companion, "linked.txt"));
    // A search root walked once holds for the turn, which writes nothing.
    expect(await denied("Grep", { pattern: "acme" })).toBe(false);
    hook = readGuard(companion);
    // Grep and Glob follow links found below their search root.
    expect(await denied("Grep", { pattern: "acme" })).toBe(true);
    expect(await denied("Glob", { pattern: "**/*.txt" })).toBe(true);
    expect(await denied("Grep", { pattern: "acme", path: "docs" })).toBe(false);
    expect(await denied("Read", { file_path: path.join(root, "secret.txt") })).toBe(true);
    expect(await denied("Read", { file_path: "../secret.txt" })).toBe(true);
    expect(await denied("Read", { file_path: "linked.txt" })).toBe(true);
    // The kernel follows the link before "..": this is the outside folder's sibling.
    await fs.mkdir(path.join(root, "outside", "inner"), { recursive: true });
    await fs.symlink(path.join(root, "outside", "inner"), path.join(companion, "l"));
    expect(await denied("Read", { file_path: "l/../secret.txt" })).toBe(true);
    expect(await denied("Read", { file_path: `${companion}/l/../x` })).toBe(true);
    expect(await denied("Grep", { pattern: "acme", path: root })).toBe(true);
    expect(await denied("Grep", { pattern: "acme", glob: "../**" })).toBe(true);
    expect(await denied("Glob", { pattern: "/etc/**" })).toBe(true);
    expect(await denied("Glob", { pattern: "~/.ssh/*" })).toBe(true);
    // Claude Code expands a leading "~" to HOME.
    await fs.mkdir(path.join(companion, "~"));
    expect(await denied("Read", { file_path: "~/.ssh/id_acme" })).toBe(true);
    expect(await denied("Grep", { pattern: "acme", path: "~" })).toBe(true);
  });

  test("allows the turn's skills and absolute globs inside the companion", async () => {
    const home = path.join(root, "home");
    const skill = path.join(home, ".claude", "skills", "acme-skill");
    await fs.mkdir(path.join(skill, "references"), { recursive: true });
    await fs.writeFile(path.join(skill, "references", "format.md"), "# Format\n");
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const hook = readGuard(companion);
      const denied = async (tool_name: string, tool_input: Record<string, unknown>) =>
        (await hook({ tool_name, tool_input })).hookSpecificOutput?.permissionDecision === "deny";
      expect(await denied("Read", { file_path: path.join(skill, "references", "format.md") })).toBe(
        false,
      );
      expect(await denied("Glob", { pattern: "**/*.md", path: skill })).toBe(false);
      // Not the rest of HOME.
      expect(await denied("Read", { file_path: path.join(home, ".claude", "settings.json") })).toBe(
        true,
      );
      expect(await denied("Glob", { pattern: path.join(companion, "**", "*.md") })).toBe(false);
      expect(await denied("Glob", { pattern: path.join(companion, "{a,b}", "*.md") })).toBe(false);
      expect(await denied("Glob", { pattern: path.join(root, "**", "*.md") })).toBe(true);
      expect(await denied("Glob", { pattern: path.join(companion, "..", "*.md") })).toBe(true);
      // An absolute glob's fixed part is walked for links too, not only its search root.
      await fs.mkdir(path.join(companion, "docs"));
      await fs.mkdir(path.join(companion, "other"));
      await fs.symlink(root, path.join(companion, "docs", "out"));
      const fresh = readGuard(companion);
      const pattern = path.join(companion, "docs", "**", "*.md");
      const answer = await fresh({ tool_name: "Glob", tool_input: { pattern, path: "other" } });
      expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
    } finally {
      process.env.HOME = saved;
    }
  });

  test("denies globs whose braces or wildcards reach above the companion", async () => {
    const hook = readGuard(companion);
    const denied = async (tool_name: string, tool_input: Record<string, unknown>) =>
      (await hook({ tool_name, tool_input })).hookSpecificOutput?.permissionDecision === "deny";

    for (const pattern of [
      "{..,.}/**/*",
      ".{.,}/secret.txt",
      "{/etc,acme}/**",
      "{~,x}/.ssh/*",
      ".?/*",
      "[.][.]/*",
    ]) {
      expect(await denied("Glob", { pattern })).toBe(true);
    }
    expect(await denied("Grep", { pattern: "acme", glob: "{..,x}/**" })).toBe(true);
    for (const pattern of ["**/*.{md,ts}", "*.*", ".github/*", "openspec/{specs,changes}/**"]) {
      expect(await denied("Glob", { pattern })).toBe(false);
    }
  });

  test("replaces the guard of a bridge installed before the current one", () => {
    const legacy = [
      "const hooks = { PreToolUse: [/* mate-studio-chat: reads stay in the companion */ {",
      '  matcher: "Read|Grep|Glob|NotebookRead|LS",',
      "  hooks: [async (hookInput) => {",
      "    return {};",
      "  }],",
      '}, { matcher: "AskUserQuestion", hooks: [] }] };',
    ].join("\n");
    const guarded = companionReadGuard(legacy);
    expect(guarded).not.toContain("reads stay in the companion */");
    expect(guarded.match(/matcher: "Read\|Grep/g)).toHaveLength(1);
    expect(guarded).toContain('{ matcher: "AskUserQuestion", hooks: [] }] };');
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(guarded)).not.toThrow();
    const v2 = companionReadGuard(guarded).replace(", v3 */", ", v2 */");
    const again = companionReadGuard(v2);
    expect(again).not.toContain(", v2 */");
    expect(again.match(/matcher: "Read\|Grep/g)).toHaveLength(1);
    expect(again).toContain('{ matcher: "AskUserQuestion", hooks: [] }] };');
  });

  test("fits the pinned harness bridge, which still parses", async () => {
    const entry = Bun.resolveSync("@ai-sdk/harness-claude-code", import.meta.dir);
    const bridge = await fs.readFile(path.join(path.dirname(entry), "bridge", "index.mjs"), "utf8");
    const guarded = companionReadGuard(userSettingsOnly(bridge));
    expect(guarded).not.toBe(companionReadGuard(bridge));
    expect(guarded).toContain('settingSources: ["user"]');
    // First among the bridge's PreToolUse hooks, its only list of them.
    expect(guarded.match(/PreToolUse:\s*\[/g)).toHaveLength(1);
    expect(guarded).toContain(
      "PreToolUse: [/* mate-studio-chat: reads stay in the companion, v3 */",
    );
    expect(companionReadGuard(userSettingsOnly(guarded))).toBe(guarded);
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(guarded)).not.toThrow();
  });
});

describe("createHostSandbox", () => {
  test("runs in the companion with a temporary HOME, no inherited credential or config, no skill shell", async () => {
    const box = await open({
      PATH: process.env.PATH,
      ANTHROPIC_API_KEY: "sk-acme",
      CLAUDE_CONFIG_DIR: "/acme/.claude",
      ACME: "1",
    });
    const result = await box.run({
      command:
        'printf "%s|%s|%s|%s|%s" "$PWD" "$HOME" "${ANTHROPIC_API_KEY:-none}" "${CLAUDE_CONFIG_DIR:-none}" "$ACME"',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${companion}|${box.home}|none|none|1`);
    expect(
      JSON.parse(await fs.readFile(path.join(box.home, ".claude", "settings.json"), "utf8")),
    ).toEqual({ disableSkillShellExecution: true });
    expect(box.home.startsWith(os.tmpdir().replace(/\/$/, ""))).toBe(true);
    expect(await fs.readlink(path.join(box.home, ".ai-sdk-harness", ".harness-bootstrap"))).toBe(
      cache,
    );
  });

  test("passes on no credential of either harness and no OpenCode or XDG configuration", async () => {
    const dropped = [
      ...CREDENTIAL_NAMES,
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG_CONTENT",
    ];
    const box = await open({
      PATH: process.env.PATH,
      ACME: "1",
      ...Object.fromEntries(dropped.map((name) => [name, "acme-secret"])),
    });
    const result = await box.run({ command: "env" });
    expect(result.stdout).not.toContain("acme-secret");
    expect(result.stdout).toContain("ACME=1");
    // What the harness hands its bridge through the spawn still arrives.
    const handed = await box.run({
      command: 'printf "%s" "$OPENAI_API_KEY"',
      env: { OPENAI_API_KEY: "sk-handed" },
    });
    expect(handed.stdout).toBe("sk-handed");
  });

  test("refuses every write into the companion and outside its state", async () => {
    const box = await open();
    for (const target of [
      path.join(companion, "x.txt"),
      "x.txt",
      "../outside.txt",
      path.join(root, "outside.txt"),
    ]) {
      await expect(box.writeTextFile({ path: target, content: "hi" })).rejects.toThrow(
        /writes nothing outside its own state/,
      );
    }
    expect(await fs.readdir(companion)).toEqual(["AGENTS.md"]);
    await box.writeTextFile({ path: path.join(box.home, "state", "a.txt"), content: "ok" });
    expect(await box.readTextFile({ path: path.join(box.home, "state", "a.txt") })).toBe("ok");
    expect(await box.readTextFile({ path: "AGENTS.md" })).toBe("# Acme\n");
    await expect(box.readTextFile({ path: "/etc/hosts" })).rejects.toThrow(/outside/);
  });

  test("writes the bridge bound to loopback and refuses to start one that is not", async () => {
    const box = await open();
    const dir = path.join(box.home, ".ai-sdk-harness", ".harness-bootstrap", "claude-code");
    await box.writeTextFile({
      path: path.join(dir, "bridge.mjs"),
      content: 'console.log({ host: "0.0.0.0" })',
    });
    expect(await fs.readFile(path.join(cache, "claude-code", "bridge.mjs"), "utf8")).toBe(
      'console.log({ host: "127.0.0.1" })',
    );
    await fs.writeFile(path.join(cache, "claude-code", "bridge.mjs"), 'x({ host: "0.0.0.0" })');
    await expect(box.spawn({ command: `node '${path.join(dir, "bridge.mjs")}'` })).rejects.toThrow(
      /loopback/,
    );
    await fs.writeFile(path.join(cache, "claude-code", "bridge.mjs"), 'x({ host: "127.0.0.1" })');
    await expect(box.spawn({ command: `node '${path.join(dir, "bridge.mjs")}'` })).rejects.toThrow(
      /reads inside the companion/,
    );
    // Not single-quoted, so the checks above could not find it.
    await expect(box.spawn({ command: `node ${path.join(dir, "bridge.mjs")}` })).rejects.toThrow(
      /quoted path/,
    );
    // A renamed bridge, or one started through `run`, would skip the checks.
    await expect(box.spawn({ command: `node '${path.join(dir, "bridge.js")}'` })).rejects.toThrow(
      /no script but its bridge/,
    );
    for (const command of [
      `node '${path.join(dir, "bridge.mjs")}'`,
      `cd '${dir}' && node bridge.mjs`,
      `exec bun ./bridge.mjs`,
    ]) {
      await expect(box.run({ command })).rejects.toThrow(/only through spawn/);
    }
    // Chained after the bridge, or another script however it starts.
    await expect(
      box.spawn({ command: `node '${path.join(dir, "bridge.mjs")}' ; node evil.js` }),
    ).rejects.toThrow(/quoted path/);
    for (const command of ["cd x && node evil.js", "exec bun evil.js", 'bash -c "npx acme"']) {
      await expect(box.spawn({ command })).rejects.toThrow(/no script but its bridge/);
      await expect(box.run({ command })).rejects.toThrow(/no script but its bridge/);
    }
    // A bridge outside the installed one, marks and all, is not started.
    const planted = path.join(companion, "x", "claude-code", "bridge.mjs");
    await fs.mkdir(path.dirname(planted), { recursive: true });
    await fs.writeFile(
      planted,
      companionReadGuard(
        userSettingsOnly(
          'x({ host: "127.0.0.1" }, { hooks: { PreToolUse: [] }, includePartialMessages: true, })',
        ),
      ),
    );
    await expect(box.spawn({ command: `node '${planted}'` })).rejects.toThrow(
      /only its installed bridge/,
    );
  });

  test("writes the OpenCode bridge on loopback without web tools, and starts it", async () => {
    const box = await open();
    const bootstrap = path.join(box.home, ".ai-sdk-harness", ".harness-bootstrap");
    const bridge = path.join(bootstrap, "opencode", "bridge.mjs");
    await box.writeTextFile({
      path: bridge,
      content: [
        'const bind = { host: "0.0.0.0" };',
        'const permission = { webfetch: "ask",\n\tdoom_loop: "ask",\n\ttask: "ask", };',
        "process.stdout.write(bind.host + ' ' + permission.webfetch + ' ' + permission.task);",
      ].join("\n"),
    });
    const proc = await box.spawn({ command: `node '${bridge}' --workdir '${companion}'` });
    expect(await new Response(proc.stdout).text()).toBe("127.0.0.1 deny deny");
    expect((await proc.wait()).exitCode).toBe(0);
    // An OpenCode bridge without the tool denial, installed before it existed, gets it on start.
    await fs.writeFile(
      path.join(cache, "opencode", "bridge.mjs"),
      'x({ host: "127.0.0.1" }, { webfetch: "ask", doom_loop: "ask", task: "ask", })',
    );
    await expect(box.spawn({ command: `node '${bridge}'` })).resolves.toBeDefined();
    expect(await fs.readFile(path.join(cache, "opencode", "bridge.mjs"), "utf8")).toContain(
      'webfetch: "deny"',
    );
    // One whose permissions changed shape cannot be guarded, so it does not start.
    await fs.writeFile(path.join(cache, "opencode", "bridge.mjs"), 'x({ host: "127.0.0.1" })');
    await expect(box.spawn({ command: `node '${bridge}'` })).rejects.toThrow(/fetch/);
    // A bridge of any other harness is refused, written or started.
    const other = path.join(bootstrap, "acme", "bridge.mjs");
    await expect(box.writeTextFile({ path: other, content: "x" })).rejects.toThrow(
      /no acme bridge/,
    );
    await expect(box.spawn({ command: `node '${other}'` })).rejects.toThrow(/no acme bridge/);
  });

  test("starts a prebuilt bridge as it is, writing nothing into it", async () => {
    const prebuilt = path.join(root, "chat-bridges");
    const installed = [
      'const bind = { host: "127.0.0.1" };',
      "/* mate-studio-chat: reads stay in the companion, v3 */",
      "/* mate-studio-chat: no companion settings */",
      "process.stdout.write(bind.host);",
    ].join("\n");
    await fs.mkdir(path.join(prebuilt, "claude-code"), { recursive: true });
    await fs.writeFile(path.join(prebuilt, "claude-code", "bridge.mjs"), installed);
    sandbox = await createHostSandbox({
      workDir: companion,
      prebuiltBridges: prebuilt,
      env: { PATH: process.env.PATH },
    });
    const link = path.join(sandbox.home, ".ai-sdk-harness", ".harness-bootstrap");
    expect(await fs.readlink(link)).toBe(prebuilt);
    const proc = await sandbox.spawn({
      command: `node '${path.join(link, "claude-code", "bridge.mjs")}' --workdir '${companion}'`,
    });
    expect(await new Response(proc.stdout).text()).toBe("127.0.0.1");
    expect(await fs.readFile(path.join(prebuilt, "claude-code", "bridge.mjs"), "utf8")).toBe(
      installed,
    );
    // The stale bridge of an older guard would need rewriting, so it is incomplete.
    await fs.writeFile(
      path.join(prebuilt, "claude-code", "bridge.mjs"),
      'x({ host: "127.0.0.1" }, { hooks: { PreToolUse: [] }, includePartialMessages: true, })',
    );
    await expect(
      sandbox.spawn({ command: `node '${path.join(link, "claude-code", "bridge.mjs")}'` }),
    ).rejects.toThrow(/prebuilt Claude Code bridge .* is missing or incomplete/);
  });

  test("refuses to install into prebuilt bridges, naming the missing one", async () => {
    const prebuilt = path.join(root, "chat-bridges");
    sandbox = await createHostSandbox({
      workDir: companion,
      prebuiltBridges: prebuilt,
      env: { PATH: process.env.PATH },
    });
    const bootstrap = path.join(
      sandbox.home,
      ".ai-sdk-harness",
      ".harness-bootstrap",
      "claude-code",
    );
    const missing = /the prebuilt Claude Code bridge in .*chat-bridges is missing or incomplete/;
    // What the harness does when it finds no marker: its directory, its files, its install.
    await expect(
      sandbox.run({ command: 'mkdir -p "$BOOTSTRAP_DIR"', env: { BOOTSTRAP_DIR: bootstrap } }),
    ).rejects.toThrow(missing);
    await expect(
      sandbox.writeTextFile({ path: path.join(bootstrap, "package.json"), content: "{}" }),
    ).rejects.toThrow(missing);
    await expect(
      sandbox.run({
        command: "pnpm install --frozen-lockfile --store-dir .pnpm-store",
        workingDirectory: bootstrap,
      }),
    ).rejects.toThrow(missing);
    // Nothing is created, not even the directory Studio was pointed at.
    expect(await fs.stat(prebuilt).catch(() => null)).toBeNull();
  });

  test("kill ends a group whose leader exited while a member holds the output", async () => {
    const box = await open();
    const pidFile = path.join(box.home, "child.pid");
    const proc = await box.spawn({ command: `sleep 30 & echo $! > '${pidFile}'` });
    const pid = Number(await waitForFile(pidFile));
    await proc.kill();
    expect(await gone(pid)).toBe(true);
  }, 10_000);

  test("stop ends a group whose leader exited and whose member let go of the pipes", async () => {
    const box = await open();
    const pidFile = path.join(box.home, "orphan.pid");
    const result = await box.run({
      command: `sleep 30 >/dev/null 2>&1 </dev/null & echo $! > '${pidFile}'`,
    });
    expect(result.exitCode).toBe(0);
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await box.stop();
    sandbox = null;
    expect(await gone(pid)).toBe(true);
  }, 10_000);

  test("refuses reads that a link inside the companion leads outside it", async () => {
    await fs.writeFile(path.join(root, "secret.txt"), "acme-secret");
    await fs.symlink(path.join(root, "secret.txt"), path.join(companion, "linked.txt"));
    const box = await open();
    await expect(box.readTextFile({ path: "linked.txt" })).rejects.toThrow(/outside/);
  });

  test("exposes only its own loopback port", async () => {
    const box = await open();
    expect(box.ports).toEqual([box.port]);
    expect(await box.getPortEndpoint({ port: box.port, protocol: "ws" })).toEqual({
      url: `ws://127.0.0.1:${box.port}`,
    });
    await expect(box.getPortEndpoint({ port: box.port + 1 })).rejects.toThrow(/not the chat/);
  });

  test("stop ends every process it started, children too, and removes its HOME", async () => {
    const box = await open();
    const pidFile = path.join(box.home, "child.pid");
    // `wait $!`, not `wait`: bash may reap the child before its own SIGTERM, and a bare `wait` exits 0.
    const proc = await box.spawn({ command: `sleep 30 & echo $! > '${pidFile}'; wait $!` });
    let pid = "";
    for (let tries = 0; !pid && tries < 50; tries += 1) {
      pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      // oxlint-disable-next-line no-await-in-loop -- polling for the child to start
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const home = box.home;
    await box.stop();
    sandbox = null;
    expect((await proc.wait()).exitCode).not.toBe(0);
    expect(() => process.kill(Number(pid.trim()), 0)).toThrow();
    expect(await fs.stat(home).catch(() => null)).toBeNull();
    await expect(box.run({ command: "true" })).rejects.toThrow(/stopped/);
  });

  test("stop kills a group member that ignores SIGTERM after its leader exits", async () => {
    const box = await open();
    const pidFile = path.join(box.home, "child.pid");
    await box.spawn({ command: `(trap '' TERM; sleep 30) & echo $! > '${pidFile}'; wait` });
    const pid = Number(await waitForFile(pidFile));
    await box.stop();
    sandbox = null;
    expect(await gone(pid)).toBe(true);
  });

  test("stop ends even when a process that left the group holds the output", async () => {
    const box = await open();
    const pidFile = path.join(box.home, "detached.pid");
    const proc = await box.spawn({
      command: `perl -e 'use POSIX qw(setsid); exit if fork; setsid(); open my $f, ">", "${pidFile}"; print $f $$; close $f; sleep 30'; wait`,
    });
    const pid = Number(await waitForFile(pidFile));
    try {
      await box.stop();
      sandbox = null;
      await proc.wait();
    } finally {
      process.kill(pid, "SIGKILL");
    }
  }, 10_000);
});

/** A signalled process answers signal 0 until its parent has reaped it, a few ms on Linux. */
async function gone(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 50; tries += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling for the reaper
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitForFile(file: string): Promise<string> {
  for (let tries = 0; tries < 100; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling for the child to start
    const text = (await fs.readFile(file, "utf8").catch(() => "")).trim();
    if (text) return text;
    // oxlint-disable-next-line no-await-in-loop -- polling for the child to start
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${file} never appeared`);
}
