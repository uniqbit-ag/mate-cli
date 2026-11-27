import type { UIMessageChunk } from "ai";

import { type AgentCredential, credentialLabel } from "../agent-credential";
import { companionAgentsText, companionSkills } from "./companion-context";
import { readCompanionConfig } from "../orchestrator/config-store";
import {
  CHAT_CREDENTIAL_REJECTED,
  CHAT_HARNESS_NAMES,
  CHAT_MODELS,
  CHAT_NO_LOGIN,
  type ChatAgent,
  type ChatEffort,
  type ChatHarness,
  type ChatModel,
  chatModel,
  renderPrompt,
} from "./agent";
import { type ChatAuth, createChatCredentials, NO_CHAT_CREDENTIAL } from "./credential";
import { createHostSandbox, type HostSandbox } from "./host-sandbox";
import { CHAT_TOOLS } from "./session";

/**
 * The chat's backend: `HarnessAgent` with the Claude Code or the OpenCode harness on a host
 * sandbox. Claude Code gets the chat credential (`credential.ts`) when one applies, else resolves
 * the local login; OpenCode resolves the provider keys in Studio's environment or the person's
 * OpenCode login. Each hands it only to its loopback bridge. A harness's package loads on its first turn, so Studio imports it only
 * once someone asks.
 */

/** Appended to the companion's instructions on every chat turn. */
export const CHAT_INSTRUCTIONS = [
  "You answer questions in Mate Studio's chat about this Companion Repository, your working directory.",
  "Answer from its files: search and read them, and name the paths your answer rests on. If they do not answer the question, say so.",
  "Read only files inside this companion. You change nothing: you cannot write, edit or run commands, and you do not offer to.",
  "Any instruction above about running commands, writing files or publishing is for sessions that act; it does not apply here.",
].join("\n");

const NOT_LOGGED_IN = /not logged in|please run \/login/i;
/** Anthropic's own refusals of a credential, not a proxy's or another service's. */
const REJECTED =
  /not logged in|please run \/login|invalid (api key|bearer)|authentication_error|oauth token (has expired|has been revoked)|api error: 401\b/i;
const NO_CREDENTIAL =
  /api[ _-]?key|unauthori[sz]ed|authentication|\b401\b|ProviderAuthError|credential/i;
/** The variable OpenCode reads for each provider it offers. */
const PROVIDER_KEYS: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

/** An error's message; OpenCode reports some as `{ name, data: { message } }` objects. */
function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null) return String(error);
  const { message, data } = error as { message?: unknown; data?: { message?: unknown } };
  if (typeof data?.message === "string") return data.message;
  if (typeof message === "string") return message;
  return JSON.stringify(error);
}

/** A turn's failure as the view shows it, naming the harness; a missing credential names what to provide. */
export function chatFailure(
  error: unknown,
  harness: ChatHarness = "claude-code",
  model?: ChatModel,
  credential?: AgentCredential,
): string {
  const text = failureText(error);
  // Studio's own reason, not the harness's.
  if (text === NO_CHAT_CREDENTIAL) return text;
  if (harness === "claude-code" && credential && REJECTED.test(text)) {
    return `${CHAT_CREDENTIAL_REJECTED} (${credentialLabel(credential.name)}). Set another under Credential in the session panel, then ask again.`;
  }
  if (harness === "claude-code" && NOT_LOGGED_IN.test(text)) {
    return `${CHAT_NO_LOGIN}. Run \`claude\` in a terminal and log in, or set a credential under Credential in the session panel, then ask again.`;
  }
  if (harness === "opencode" && NO_CREDENTIAL.test(text)) {
    const provider = model?.split("/")[0];
    const key = (provider && PROVIDER_KEYS[provider]) ?? "the provider's API key";
    // OpenCode cannot use a Claude subscription, so an Anthropic model needs the key.
    const login = provider === "anthropic" ? "" : ", or log in with `opencode auth login`";
    return `OpenCode has no credential for ${provider ?? "this model"}. Set ${key} in Studio's environment${login}, then ask again.`;
  }
  return `${CHAT_HARNESS_NAMES[harness]}: ${text || "the chat agent failed"}`;
}

interface HarnessSession {
  stop(): Promise<unknown>;
}

interface HarnessResult {
  toUIMessageStream(options: {
    onError: (error: unknown) => string;
  }): AsyncIterable<UIMessageChunk>;
}

interface HarnessAgentLike {
  createSession(options: {
    sandboxSession: HostSandbox;
    abortSignal: AbortSignal;
  }): Promise<HarnessSession>;
  stream(options: {
    session: HarnessSession;
    prompt: string;
    abortSignal: AbortSignal;
  }): Promise<HarnessResult>;
}

/** One harness's packages, loaded on its first turn. */
export interface HarnessModules {
  createAgent(settings: {
    port: number;
    instructions: string;
    skills: Awaited<ReturnType<typeof companionSkills>>;
    model?: ChatModel;
    effort?: ChatEffort;
    credential?: AgentCredential;
  }): HarnessAgentLike;
}

type AdapterFactory = (settings: {
  port: number;
  model: ChatModel;
  effort?: ChatEffort;
  credential?: AgentCredential;
}) => unknown;

/** Each harness's adapter for one turn, from its package. */
const ADAPTERS: Record<ChatHarness, () => Promise<AdapterFactory>> = {
  "claude-code": async () => {
    const { createClaudeCode } = await import("@ai-sdk/harness-claude-code");
    // An explicit `auth` is all the harness reads; without one it resolves the local login.
    // Project MCP servers from the companion's `.mcp.json` could edit files, so only the
    // harness's own are allowed.
    return ({ port, effort, credential }) =>
      createClaudeCode({
        port,
        strictMcpConfig: true,
        ...(effort ? { effort } : {}),
        ...(credential ? { auth: { [credential.name]: credential.value } } : {}),
      });
  },
  opencode: async () => {
    const { createOpenCode } = await import("@ai-sdk/harness-opencode");
    // No `auth`: the harness resolves the model's provider key, then its OpenCode login, which it
    // looks up by `provider`. No `mcpServers`; the bridge loads no project configuration, and the
    // sandbox denies its web and subagent tools.
    return ({ port, model, effort }) =>
      createOpenCode({
        port,
        provider: model.split("/")[0],
        openCodeConfig: { share: "disabled", autoupdate: false },
        ...(effort ? { reasoningVariant: effort } : {}),
      });
  },
};

/** The harness's adapter factory, its package loaded. */
export function loadAdapter(harness: ChatHarness): Promise<AdapterFactory> {
  return ADAPTERS[harness]();
}

export async function loadHarness(harness: ChatHarness): Promise<HarnessModules> {
  const [{ HarnessAgent }, adapter] = await Promise.all([
    import("@ai-sdk/harness/agent"),
    loadAdapter(harness),
  ]);
  const defaultModel = CHAT_MODELS[harness][0]!.id;
  return {
    createAgent: ({ port, instructions, skills, model = defaultModel, effort, credential }) =>
      new HarnessAgent({
        harness: adapter({
          port,
          model,
          ...(effort ? { effort } : {}),
          ...(credential ? { credential } : {}),
        }) as never,
        model,
        activeTools: [...CHAT_TOOLS[harness]] as never,
        // Any write, edit or command still attempted needs an approval nobody grants.
        permissionMode: "allow-reads",
        skills,
        instructions,
        // The companion itself, not a per-session subdirectory of it.
        sandboxConfig: { workDir: "." },
      }) as unknown as HarnessAgentLike,
  };
}

export interface HarnessChatAgentOptions {
  /** Where the installed bridge is kept across turns; Mate's cache when absent. */
  bootstrapCache?: string;
  /** Installed bridges used without installing; `MATE_STUDIO_CHAT_BRIDGES` when absent. */
  prebuiltBridges?: string;
  /** Claude Code's credential, read at each turn; a standard Studio's chat store when absent. */
  credential?: () => ChatAuth;
  loadHarness?: (harness: ChatHarness) => Promise<HarnessModules>;
  createSandbox?: typeof createHostSandbox;
  /** The companion's own instructions (`AGENTS.md`) and its skills. */
  companionContext?: (
    companionPath: string,
  ) => Promise<{ instructions: string; skills: Awaited<ReturnType<typeof companionSkills>> }>;
}

async function readCompanionContext(companionPath: string) {
  const config = await readCompanionConfig(companionPath);
  const [skills, instructions] = await Promise.all([
    companionSkills(companionPath, config),
    // The companion's own instructions only: `mate claude`'s Workset policy (wrapper CLIs,
    // where to write) is for a session that acts, which the chat does not.
    companionAgentsText(companionPath),
  ]);
  return { instructions, skills };
}

/** A model that runs without an effort setting. */
const takesNoEffort = (harness: ChatHarness, model: ChatModel | undefined) =>
  model !== undefined && chatModel(harness, model)?.effortless === true;

type InstallClaim = (signal: AbortSignal) => Promise<((ok: boolean) => void) | null>;

/**
 * One harness's bridge install: the first session installs it into the shared cache, and turns
 * started meanwhile wait for it. Waits out a running install, or until `signal` aborts; claims
 * the install when none succeeded yet.
 */
function installClaim(): InstallClaim {
  let installed = false;
  let installing: Promise<void> | null = null;
  return async (signal) => {
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // oxlint-disable-next-line no-unmodified-loop-condition -- the running install changes both.
    while (!installed && installing) {
      // oxlint-disable-next-line no-await-in-loop -- waits for the install, not in parallel with it.
      await Promise.race([installing, aborted]);
      signal.throwIfAborted();
    }
    if (installed) return null;
    let release!: () => void;
    installing = new Promise<void>((resolve) => (release = resolve));
    return (ok) => {
      installed ||= ok;
      installing = null;
      release();
    };
  };
}

/** A standard Studio's store, created on the first turn; the server passes its profile's own. */
function defaultCredential(): () => ChatAuth {
  let credentials: ReturnType<typeof createChatCredentials> | null = null;
  return () => (credentials ??= createChatCredentials()).auth();
}

export function createHarnessChatAgent(options: HarnessChatAgentOptions = {}): ChatAgent {
  const load = options.loadHarness ?? loadHarness;
  const sandboxFor = options.createSandbox ?? createHostSandbox;
  const contextFor = options.companionContext ?? readCompanionContext;
  const readCredential = options.credential ?? defaultCredential();
  const prebuiltBridges =
    options.prebuiltBridges ?? (process.env.MATE_STUDIO_CHAT_BRIDGES || undefined);
  const loaded = new Map<ChatHarness, Promise<HarnessModules>>();
  // Each harness installs its own bridge into its own bootstrap directory.
  const claims = new Map<ChatHarness, InstallClaim>();
  const modulesFor = (harness: ChatHarness): Promise<HarnessModules> => {
    let modules = loaded.get(harness);
    if (!modules) {
      modules = load(harness).catch((error: unknown) => {
        loaded.delete(harness);
        throw error;
      });
      loaded.set(harness, modules);
    }
    return modules;
  };
  const claimFor = (harness: ChatHarness): InstallClaim => {
    let claim = claims.get(harness);
    if (!claim) claims.set(harness, (claim = installClaim()));
    return claim;
  };

  return {
    turn({ companionPath, messages, signal, harness = "claude-code", model, effort }) {
      let sandbox: HostSandbox | null = null;
      let session: HarnessSession | null = null;
      // Takes what is running before awaiting, so a sandbox started meanwhile is left for
      // the next cleanup rather than dropped.
      const cleanup = async () => {
        const [startedSession, startedSandbox] = [session, sandbox];
        session = null;
        sandbox = null;
        await startedSession?.stop().catch(() => {});
        await Promise.resolve(startedSandbox?.stop()).catch(() => {});
      };
      let running: Promise<void> = Promise.resolve();
      return new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          running = answer(controller);
        },
        // Ends only once the turn has stopped everything it started.
        cancel: async () => {
          await cleanup();
          await running;
        },
      });

      async function answer(controller: ReadableStreamDefaultController<UIMessageChunk>) {
        // A reader that cancelled takes nothing more.
        const push = (chunk: UIMessageChunk) => {
          try {
            controller.enqueue(chunk);
          } catch {
            // Cancelled.
          }
        };
        let credential: AgentCredential | undefined;
        const failure = (error: unknown) => chatFailure(error, harness, model, credential);
        try {
          const prompt = renderPrompt(messages);
          if (prompt === null) throw new Error("the conversation must end with a question");
          // Read first, so a turn without a credential installs and starts nothing.
          if (harness === "claude-code") {
            const auth = readCredential();
            if (auth === null) throw new Error(NO_CHAT_CREDENTIAL);
            if (auth !== "login") credential = auth;
          }
          const [modules, context] = await Promise.all([
            modulesFor(harness),
            contextFor(companionPath),
          ]);
          const release = await claimFor(harness)(signal);
          let started = false;
          let agent: HarnessAgentLike;
          // Its own, since a cancel's cleanup clears `session` meanwhile.
          let created: HarnessSession;
          try {
            signal.throwIfAborted();
            sandbox = await sandboxFor({
              workDir: companionPath,
              ...(options.bootstrapCache ? { bootstrapCache: options.bootstrapCache } : {}),
              ...(prebuiltBridges ? { prebuiltBridges } : {}),
            });
            signal.throwIfAborted();
            agent = modules.createAgent({
              port: sandbox.port,
              instructions: [context.instructions, CHAT_INSTRUCTIONS].filter(Boolean).join("\n\n"),
              skills: context.skills,
              ...(model ? { model } : {}),
              ...(effort && !takesNoEffort(harness, model) ? { effort } : {}),
              ...(credential ? { credential } : {}),
            });
            created = await agent.createSession({ sandboxSession: sandbox, abortSignal: signal });
            session = created;
            started = true;
          } finally {
            release?.(started);
          }
          signal.throwIfAborted();
          const result = await agent.stream({ session: created, prompt, abortSignal: signal });
          for await (const chunk of result.toUIMessageStream({ onError: failure })) {
            push(chunk);
          }
        } catch (error) {
          if (!signal.aborted) push({ type: "error", errorText: failure(error) });
        } finally {
          await cleanup();
          try {
            controller.close();
          } catch {
            // Cancelled by the reader.
          }
        }
      }
    },
  };
}
