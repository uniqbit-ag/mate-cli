import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, initRepo } from "../../test/git-checkouts";
import { companionLinkPath } from "../runtime/repo-local";
import type { CompanionContext } from "./companion-policy";
import { ENTER_WORKTREE_TOOL, EXIT_WORKTREE_TOOL, registerEnterWorktree } from "./enter-worktree";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Execute = (
  input: unknown,
  tool: { sessionID: string },
) => Promise<{ content: string; metadata: Record<string, unknown> }>;

/** `<root>/web` linked to `<root>/companion`, with a worktree at `<root>/web.worktrees/acme-fix`. */
function layout() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-enter-")));
  tempRoots.push(root);
  const companionPath = path.join(root, "companion");
  fs.mkdirSync(companionPath);
  const web = initRepo(path.join(root, "web"));
  const worktree = addWorktree(web, path.join(root, "web.worktrees", "acme-fix"));
  linkTo(worktree, companionPath);
  return { root, companionPath, web, worktree };
}

function linkTo(repo: string, companion: string): void {
  fs.mkdirSync(path.dirname(companionLinkPath(repo)), { recursive: true });
  fs.symlinkSync(companion, companionLinkPath(repo));
}

type ContextHook = (event: { sessionID: string; system: unknown[] }) => unknown;

interface Subscriber {
  queue: unknown[];
  wake?: () => void;
  handled?: () => void;
}

/** A server-wide event stream; each `emit` resolves once every subscribed instance handled it. */
function eventStream() {
  const subscribers = new Set<Subscriber>();
  return {
    async *subscribe({ signal }: { signal: AbortSignal }) {
      const subscriber: Subscriber = { queue: [] };
      subscribers.add(subscriber);
      while (!signal.aborted) {
        if (subscriber.queue.length === 0) {
          subscriber.handled?.();
          await new Promise<void>((resolve) => (subscriber.wake = resolve));
          continue;
        }
        yield subscriber.queue.shift();
      }
      subscribers.delete(subscriber);
    },
    async emit(event: unknown): Promise<void> {
      await Promise.all(
        [...subscribers].map((subscriber) => {
          subscriber.queue.push(event);
          const done = new Promise<void>((resolve) => (subscriber.handled = resolve));
          subscriber.wake?.();
          return done;
        }),
      );
    },
  };
}

const afterCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of afterCleanups.splice(0)) cleanup();
});

/** One OpenCode server: sessions, moves and events shared by its plugin instances. */
function server() {
  const moves: { sessionID: string; directory: string }[] = [];
  const directories = new Map<string, string>();
  const contextHooks: ContextHook[] = [];
  const events = eventStream();
  let failGet = false;

  /** A plugin instance set up for `location`, `context.repositoryPath` unless given. */
  async function instance(
    context: Partial<CompanionContext>,
    options: { location?: string; registered?: (id: string) => Promise<boolean> } = {},
  ) {
    const location = options.location ?? context.repositoryPath!;
    const executes = new Map<string, Execute>();
    const api = {
      location: { directory: location },
      tool: {
        transform: async (transform: (editor: { add: (tool: unknown) => void }) => void) => {
          transform({
            add: (entry) => {
              const added = entry as { name: string; execute: Execute };
              executes.set(added.name, added.execute);
            },
          });
        },
      },
      session: {
        move: async (input: { sessionID: string; directory: string }) => {
          moves.push(input);
          directories.set(input.sessionID, input.directory);
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          if (failGet) throw new Error("server unavailable");
          return { location: { directory: directories.get(sessionID) ?? location } };
        },
        hook: async (name: string, hook: ContextHook) => {
          if (name === "context") contextHooks.push(hook);
        },
      },
      event: { subscribe: events.subscribe },
    };
    const cleanup = await registerEnterWorktree(
      api as never,
      { frameworkName: "mate", ...context } as CompanionContext,
      { registered: options.registered ?? (async () => false) },
    );
    afterCleanups.push(cleanup);
    return {
      execute: (target: unknown, sessionID = "ses_acme") =>
        executes.get(ENTER_WORKTREE_TOOL)!({ path: target }, { sessionID }),
      exit: (sessionID = "ses_acme") => executes.get(EXIT_WORKTREE_TOOL)!({}, { sessionID }),
    };
  }

  return {
    moves,
    instance,
    /** Places a session, as a move outside these tools does. */
    place: (sessionID: string, directory: string) => directories.set(sessionID, directory),
    failGet: () => (failGet = true),
    /** Resolves once every instance took the event and follow moves without a pending lookup ran. */
    created: async (sessionID: string, directory: string, parentID?: string) => {
      directories.set(sessionID, directory);
      await events.emit({
        type: "session.created",
        location: { directory },
        data: { sessionID, ...(parentID ? { parentID } : {}) },
      });
      await Bun.sleep(0);
    },
    /** The system prompt of the session's next request, after every instance's context hook. */
    system: async (sessionID: string) => {
      const system: unknown[] = [{ type: "text", text: "companion" }];
      for (const hook of contextHooks) await hook({ sessionID, system });
      return system as { text: string }[];
    },
  };
}

/** A single plugin instance in `context.repositoryPath`, on its own server. */
async function tool(context: Partial<CompanionContext>) {
  const opencode = server();
  const plugin = await opencode.instance(context);
  return { ...opencode, ...plugin };
}

describe("mate_enter_worktree", () => {
  test("moves the calling session into a worktree of its repository", async () => {
    const { companionPath, web, worktree } = layout();
    const { moves, execute } = await tool({ companionPath, repositoryPath: web });
    const result = await execute(worktree);
    expect(moves).toEqual([{ sessionID: "ses_acme", directory: worktree }]);
    expect(result.metadata).toEqual({ moved: true, directory: worktree });
    expect(result.content).toContain(worktree);
  });

  test("moves a session from one worktree into another of the same repository", async () => {
    const { companionPath, web, worktree } = layout();
    const docs = addWorktree(web, path.join(path.dirname(worktree), "acme-docs"));
    linkTo(docs, companionPath);
    const opencode = server();
    const plugin = await opencode.instance({ companionPath, repositoryPath: worktree });
    expect((await plugin.execute(docs)).metadata).toEqual({ moved: true, directory: docs });
  });

  test("refuses a folder inside a worktree and says it must be the root", async () => {
    const { companionPath, web, worktree } = layout();
    const inner = path.join(worktree, "packages", "acme");
    fs.mkdirSync(inner, { recursive: true });
    const { moves, execute } = await tool({ companionPath, repositoryPath: web });
    const result = await execute(inner);
    expect(moves).toEqual([]);
    expect(result.content).toContain(`${inner} is not the root of a Git worktree`);
  });

  test("refuses a worktree of another repository", async () => {
    const { root, companionPath, web } = layout();
    const api = initRepo(path.join(root, "api"));
    const other = addWorktree(api, path.join(root, "api.worktrees", "acme-fix"));
    linkTo(other, companionPath);
    const { moves, execute } = await tool({ companionPath, repositoryPath: web });
    const result = await execute(other);
    expect(moves).toEqual([]);
    expect(result.metadata).toEqual({ moved: false });
    expect(result.content).toContain(`is not a linked worktree of ${web}`);
  });

  test("refuses a plain directory and the main checkout", async () => {
    const { root, companionPath, web } = layout();
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    const { moves, execute } = await tool({ companionPath, repositoryPath: web });
    expect((await execute(plain)).metadata).toEqual({ moved: false });
    expect((await execute(web)).metadata).toEqual({ moved: false });
    expect(moves).toEqual([]);
  });

  test("refuses a worktree linked to another companion", async () => {
    const { root, web } = layout();
    const other = path.join(root, "other-companion");
    fs.mkdirSync(other);
    const { moves, execute } = await tool({ companionPath: other, repositoryPath: web });
    const result = await execute(path.join(root, "web.worktrees", "acme-fix"));
    expect(moves).toEqual([]);
    expect(result.content).toContain(`is not linked to the companion ${other}`);
  });

  test("refuses input without a path", async () => {
    const { companionPath, web } = layout();
    const { moves, execute } = await tool({ companionPath, repositoryPath: web });
    expect((await execute(undefined)).content).toContain("the path must be a string");
    expect(moves).toEqual([]);
  });
});

describe("new sessions follow the last entered worktree", () => {
  test("moves a new root session in the main checkout and notes where", async () => {
    const { companionPath, web, worktree } = layout();
    const plugin = await tool({ companionPath, repositoryPath: web });
    await plugin.execute(worktree);
    await plugin.created("ses_new", web);
    expect(plugin.moves.at(-1)).toEqual({ sessionID: "ses_new", directory: worktree });
    expect((await plugin.system("ses_new"))[0]!.text).toContain(
      `moved into the worktree ${worktree}`,
    );
    expect((await plugin.system("ses_other"))[0]!.text).toBe("companion");
  });

  test("follows the worktree entered last", async () => {
    const { companionPath, web, worktree } = layout();
    const docs = addWorktree(web, path.join(path.dirname(worktree), "acme-docs"));
    linkTo(docs, companionPath);
    const plugin = await tool({ companionPath, repositoryPath: web });
    await plugin.execute(worktree);
    await plugin.execute(docs, "ses_docs");
    await plugin.created("ses_new", web);
    expect(plugin.moves.at(-1)).toEqual({ sessionID: "ses_new", directory: docs });
  });

  test("forgets a removed worktree and leaves the session in the main checkout", async () => {
    const { companionPath, web, worktree } = layout();
    const plugin = await tool({ companionPath, repositoryPath: web });
    await plugin.execute(worktree);
    fs.rmSync(worktree, { recursive: true, force: true });
    await plugin.created("ses_new", web);
    await plugin.created("ses_later", web);
    expect(plugin.moves).toHaveLength(1);
    expect((await plugin.system("ses_new"))[0]!.text).toBe("companion");
  });

  test("never moves a child session or a session outside the main checkout", async () => {
    const { root, companionPath, web, worktree } = layout();
    const plugin = await tool({ companionPath, repositoryPath: web });
    await plugin.execute(worktree);
    await plugin.created("ses_child", web, "ses_acme");
    await plugin.created("ses_elsewhere", root);
    expect(plugin.moves).toHaveLength(1);
  });

  test("moves nothing before any session entered a worktree", async () => {
    const { companionPath, web } = layout();
    const plugin = await tool({ companionPath, repositoryPath: web });
    await plugin.created("ses_new", web);
    expect(plugin.moves).toEqual([]);
  });

  test("never moves a session an editor registered in the directory it chose", async () => {
    const { companionPath, web, worktree } = layout();
    const opencode = server();
    const plugin = await opencode.instance(
      { companionPath, repositoryPath: web },
      { registered: async (id) => id === "ses_editor" },
    );
    await plugin.execute(worktree);
    await opencode.created("ses_editor", web);
    expect(opencode.moves).toHaveLength(1);
  });

  test("the first request of a new session waits for its move", async () => {
    const { companionPath, web, worktree } = layout();
    const opencode = server();
    let release: (() => void) | undefined;
    const plugin = await opencode.instance(
      { companionPath, repositoryPath: web },
      { registered: () => new Promise((resolve) => (release = () => resolve(false))) },
    );
    await plugin.execute(worktree);
    await opencode.created("ses_new", web);
    const system = opencode.system("ses_new");
    await Bun.sleep(5);
    release!();
    expect((await system)[0]!.text).toContain(`moved into the worktree ${worktree}`);
  });

  test("a pending move holds up no later session", async () => {
    const { companionPath, web, worktree } = layout();
    const opencode = server();
    const plugin = await opencode.instance(
      { companionPath, repositoryPath: web },
      { registered: (id) => (id === "ses_slow" ? new Promise(() => {}) : Promise.resolve(false)) },
    );
    await plugin.execute(worktree);
    await opencode.created("ses_slow", web);
    await opencode.created("ses_new", web);
    expect(opencode.moves.at(-1)).toEqual({ sessionID: "ses_new", directory: worktree });
  });

  test("an exit during a pending lookup wins", async () => {
    const { companionPath, web, worktree } = layout();
    const opencode = server();
    let release: (() => void) | undefined;
    const plugin = await opencode.instance(
      { companionPath, repositoryPath: web },
      { registered: () => new Promise((resolve) => (release = () => resolve(false))) },
    );
    await plugin.execute(worktree);
    await opencode.created("ses_new", web);
    await plugin.exit("ses_main");
    release!();
    expect((await opencode.system("ses_new"))[0]!.text).toBe("companion");
    expect(opencode.moves.filter((move) => move.sessionID === "ses_new")).toEqual([]);
  });

  test("follows from an instance in a folder of the main checkout", async () => {
    const { companionPath, web, worktree } = layout();
    const inner = path.join(web, "apps", "acme");
    fs.mkdirSync(inner, { recursive: true });
    const opencode = server();
    const root = await opencode.instance({ companionPath, repositoryPath: web });
    await opencode.instance({ companionPath, repositoryPath: web }, { location: inner });
    await root.execute(worktree);
    await opencode.created("ses_new", inner);
    expect(opencode.moves.filter((move) => move.sessionID === "ses_new")).toEqual([
      { sessionID: "ses_new", directory: worktree },
    ]);
  });

  test("drops the note once the session left the worktree", async () => {
    const { companionPath, web, worktree } = layout();
    const plugin = await tool({ companionPath, repositoryPath: web });
    await plugin.execute(worktree);
    await plugin.created("ses_new", web);
    plugin.place("ses_new", web);
    expect((await plugin.system("ses_new"))[0]!.text).toBe("companion");
  });
});

describe("one server with an instance per location", () => {
  async function serverWithWorktree() {
    const paths = layout();
    const opencode = server();
    const main = await opencode.instance({
      companionPath: paths.companionPath,
      repositoryPath: paths.web,
    });
    const inWorktree = await opencode.instance({
      companionPath: paths.companionPath,
      repositoryPath: paths.worktree,
    });
    return { ...paths, opencode, main, inWorktree };
  }

  test("moves a new session once, from the main checkout's instance", async () => {
    const { web, worktree, opencode, main } = await serverWithWorktree();
    await main.execute(worktree);
    await opencode.created("ses_new", web);
    expect(opencode.moves.filter((move) => move.sessionID === "ses_new")).toHaveLength(1);
    const notes = (await opencode.system("ses_new"))[0]!.text.split("moved into the worktree");
    expect(notes).toHaveLength(2);
  });

  test("exit in the worktree's instance moves back and stops following", async () => {
    const { web, worktree, opencode, main, inWorktree } = await serverWithWorktree();
    await main.execute(worktree);
    const result = await inWorktree.exit();
    expect(result.metadata).toEqual({ moved: true, directory: web });
    await opencode.created("ses_new", web);
    expect(opencode.moves.filter((move) => move.sessionID === "ses_new")).toEqual([]);
  });
});

describe("mate_exit_worktree", () => {
  test("moves the caller back to the main checkout and stops following", async () => {
    const { companionPath, web, worktree } = layout();
    const plugin = await tool({ companionPath, repositoryPath: web });
    await plugin.execute(worktree);
    const result = await plugin.exit();
    expect(plugin.moves.at(-1)).toEqual({ sessionID: "ses_acme", directory: web });
    expect(result.metadata).toEqual({ moved: true, directory: web });
    expect(fs.existsSync(worktree)).toBe(true);
    await plugin.created("ses_new", web);
    expect(plugin.moves).toHaveLength(2);
  });

  test("moves back from a folder inside the worktree", async () => {
    const { companionPath, web, worktree } = layout();
    const inner = path.join(worktree, "packages", "acme");
    fs.mkdirSync(inner, { recursive: true });
    const plugin = await tool({ companionPath, repositoryPath: web });
    plugin.place("ses_acme", inner);
    expect((await plugin.exit()).metadata).toEqual({ moved: true, directory: web });
  });

  test("stays in the main checkout and still stops following", async () => {
    const { companionPath, web, worktree } = layout();
    const plugin = await tool({ companionPath, repositoryPath: web });
    await plugin.execute(worktree);
    const result = await plugin.exit("ses_main");
    expect(result.metadata).toEqual({ moved: false });
    expect(result.content).toContain(`stays in ${web}`);
    await plugin.created("ses_new", web);
    expect(plugin.moves).toHaveLength(1);
  });

  test("stops following even when the session cannot be read", async () => {
    const { companionPath, web, worktree } = layout();
    const plugin = await tool({ companionPath, repositoryPath: web });
    await plugin.execute(worktree);
    plugin.failGet();
    await expect(plugin.exit()).rejects.toThrow("server unavailable");
    await plugin.created("ses_new", web);
    expect(plugin.moves).toHaveLength(1);
  });

  test("moves only the caller", async () => {
    const { companionPath, web, worktree } = layout();
    const plugin = await tool({ companionPath, repositoryPath: web });
    await plugin.execute(worktree);
    await plugin.execute(worktree, "ses_peer");
    await plugin.exit();
    expect(plugin.moves.filter((move) => move.sessionID === "ses_peer")).toEqual([
      { sessionID: "ses_peer", directory: worktree },
    ]);
  });
});
