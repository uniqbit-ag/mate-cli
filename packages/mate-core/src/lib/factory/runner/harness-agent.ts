import { randomUUID } from "node:crypto";

import type { FactoryClient } from "../client";
import { readWorksets } from "../../workset/record";
import { createWorksetSandbox } from "../sandbox";
import { companionSession, companionSkills } from "./companion-context";
import type { RunStore } from "./state";
import { type StageAgent, StageError, type TurnOutcome } from "./workflow";

/**
 * Agent turns through `HarnessAgent` and the Claude Code harness, inside the Workset's
 * container through the broker-backed sandbox. The harness packages load only here, on
 * the first turn, so Studio without factory mode never imports them.
 *
 * The credential is never held: the adapter gets an empty auth environment, so it sends
 * no credential to the bridge, the sandbox starts the bridge with `agent: true`, and the
 * broker sets the value in the bridge's own environment.
 */

export const BRIDGE_PORT = 7681;
const ASK_HUMAN_REPLY =
  "Question recorded. Stop now and wait; the answer arrives as the next message.";

export interface HarnessStageAgentOptions {
  client: FactoryClient;
  attachSocket: string;
  store: RunStore;
  /** The companion whose skills and AGENTS.md each turn gets, as `mate claude` gives a session. */
  companionPath: string;
  worktreeOf: (id: string) => string;
  /** The unprivileged user's home inside Workset containers. */
  home: string;
}

/** The stream parts a turn reads; every other part type is ignored. */
export type TurnPart =
  | { type: "text-delta"; id?: string; text: string }
  | { type: "text-end"; id: string }
  | { type: "error"; error: unknown }
  | { type: "finish"; finishReason: string }
  | { type: string };

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error) ?? String(error);
}

/**
 * Logs the turn's text and returns why it failed, or `null` when it finished. Text
 * blocks can stream side by side, so each is logged whole when it ends.
 */
export async function followTurn(
  parts: AsyncIterable<TurnPart>,
  onText: (text: string) => void,
): Promise<string | null> {
  let failure: string | null = null;
  const blocks = new Map<string, string>();
  const flush = (id: string) => {
    const text = blocks.get(id);
    blocks.delete(id);
    if (text) onText(text.endsWith("\n") ? text : `${text}\n`);
  };
  for await (const part of parts) {
    if (part.type === "text-delta" && "text" in part) {
      if (part.id === undefined) onText(part.text);
      else blocks.set(part.id, (blocks.get(part.id) ?? "") + part.text);
    } else if (part.type === "text-end" && "id" in part) flush(part.id);
    else if (part.type === "error" && "error" in part) failure = describe(part.error);
    else if (part.type === "finish" && "finishReason" in part && part.finishReason === "error")
      failure ??= "the agent ended with an error";
  }
  for (const id of blocks.keys()) flush(id);
  return failure;
}

export function createHarnessStageAgent(options: HarnessStageAgentOptions): StageAgent {
  return {
    async turn({ worksetId, prompt, signal, onText }): Promise<TurnOutcome> {
      const [{ HarnessAgent }, { createClaudeCode }, { tool }, { z }] = await Promise.all([
        import("@ai-sdk/harness/agent"),
        import("@ai-sdk/harness-claude-code"),
        import("ai"),
        import("zod"),
      ]);
      let question: string | null = null;
      const turnAbort = new AbortController();
      const forward = () => turnAbort.abort(signal.reason);
      signal.addEventListener("abort", forward, { once: true });

      const askHuman = tool({
        description:
          "Ask the engineer a question you cannot answer from the Workset, the code or the companion. The turn ends; the answer arrives as the next message.",
        inputSchema: z.object({ question: z.string().min(1) }),
        execute: async ({ question: asked }) => {
          question = asked;
          // The tool result reaches the agent first, then the turn is cut.
          setTimeout(() => turnAbort.abort(new Error("waiting for a person")), 0);
          return ASK_HUMAN_REPLY;
        },
      });
      const worktree = options.worktreeOf(worksetId);
      const record = (await readWorksets(options.companionPath)).worksets.find(
        (entry) => entry.id === worksetId,
      );
      const [skills, { instructions, env }] = await Promise.all([
        companionSkills(options.companionPath),
        companionSession(options.companionPath, {
          id: record?.repositories[0] ?? worksetId,
          path: worktree,
        }),
      ]);
      const agent = new HarnessAgent({
        // Any credential named here would reach the bridge per session and override the
        // broker's real one, so none is named.
        harness: createClaudeCode({ auth: {}, port: BRIDGE_PORT, env }),
        tools: { ask_human: askHuman },
        // Nobody answers Claude's own question tool in an unattended turn; ask_human is the way to ask.
        inactiveTools: ["askUserQuestions"],
        skills,
        instructions,
        permissionMode: "allow-all",
        // The worktree itself, not a per-session subdirectory of it.
        sandboxConfig: { workDir: "." },
      });
      const sandbox = createWorksetSandbox({
        id: worksetId,
        worktree,
        home: options.home,
        client: options.client,
        attachSocket: options.attachSocket,
        bridgePort: BRIDGE_PORT,
        agentSpawns: true,
        sessionId: () => randomUUID(),
      });
      const memory = await options.store.readMemory(worksetId);
      const session = await agent.createSession({
        sandboxSession: sandbox,
        ...(memory.resume ? { resumeFrom: memory.resume as never } : {}),
        abortSignal: turnAbort.signal,
      });
      try {
        const result = await agent.stream({
          session,
          prompt,
          abortSignal: turnAbort.signal,
        } as never);
        // The full stream, not only its text: a failed API call ends the turn without
        // throwing, and would otherwise read as a finished stage.
        const failure = await followTurn(
          (result as { fullStream: AsyncIterable<TurnPart> }).fullStream,
          onText,
        );
        if (failure !== null) throw new StageError(`the agent turn failed: ${failure}`);
      } catch (error) {
        if (question === null) throw error;
      } finally {
        signal.removeEventListener("abort", forward);
        const resume = await session.stop().catch(() => undefined);
        await options.store.writeMemory(worksetId, { ...memory, ...(resume ? { resume } : {}) });
        await sandbox.stop();
      }
      return question === null ? { kind: "done" } : { kind: "question", question };
    },
  };
}
