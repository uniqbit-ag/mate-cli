import { randomUUID } from "node:crypto";

import type { FactoryClient } from "../client";
import { findWorkset } from "../../workset/record";
import { createWorksetSandbox } from "../sandbox";
import { companionSession, companionSkills } from "./companion-context";
import type { TurnEvent } from "./live";
import type { Run } from "./run";
import type { Situation } from "./state";
import { type AgentQuestion, type StageAgent, StageError, type TurnOutcome } from "./workflow";

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

/**
 * The factory's whole asking policy, appended to the companion's instructions on every
 * factory turn, resumed ones included. Skills carry no factory text: outside the factory
 * this never appears, so the same skills behave as in a person's session.
 */
export function factoryRunInstructions(): string {
  return [
    "You run in the Mate factory, unattended, inside a Workset container on a person's Outcome: what they want, in their words. The person sees your questions and your situation in Studio.",
    "Never use the runtime's own question tool; nobody answers it. Ask a person only through ask_human, then end your turn; the answers arrive as the next message.",
    "Ask together: every question you can already ask in one call, up to five. A follow-up that depends on an answer waits for the next round. This overrides a skill's one question at a time; a skill's confirmation step, such as \"Yes, no, or refine?\", is a question too.",
    "When an answer is a choice, give 2-4 short options and the one you recommend, and say why in the question.",
    "Ask only for authorization, missing facts without a reasonable default, anything hard to undo, or a choice between real alternatives. For everything else take the answer you would recommend, continue, and record it as an assumption.",
    "Write each assumption as `Assumed: <choice> (<why>)`, under Assumptions in a PRE-EXPLORE HANDOFF, in a proposal's Impact section and in your final message. Prefer the reversible, smaller choice; the person corrects it at the review.",
    "Before you end a stage, call report_situation once with one plain sentence the person understands without knowing the factory: what now exists or was decided. Never name a skill, an agent or a stage. After verification, pass each check you ran and whether it passed. When you stop on a question, report nothing.",
    "A proposed change always waits for a person's Approve. Write only what the stage you run writes.",
  ].join("\n");
}

export interface HarnessStageAgentOptions {
  client: FactoryClient;
  attachSocket: string;
  runs: Run;
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
  | { type: "tool-call"; toolName: string; input?: unknown }
  | { type: "tool-result"; toolName: string }
  | { type: "tool-error"; toolName: string }
  | { type: "error"; error: unknown }
  | { type: "finish"; finishReason: string }
  | { type: string };

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error) ?? String(error);
}

const SUMMARY_CHARS = 80;

/** A tool input's first text value, one line and short: a command, a path or a pattern. */
export function toolSummary(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const first = Object.values(input).find((value) => typeof value === "string");
  const line = (first ?? "").replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

/**
 * Logs the turn's text and returns why it failed, or `null` when it finished. Text
 * blocks can stream side by side, so each is logged whole when it ends. `onEvent` sees
 * the text as it streams and the tool calls; text it saw is logged as `streamed`.
 */
export async function followTurn(
  parts: AsyncIterable<TurnPart>,
  onText: (text: string, streamed?: boolean) => void,
  onEvent?: (event: TurnEvent) => void,
): Promise<string | null> {
  const streamed = onEvent !== undefined;
  let failure: string | null = null;
  const blocks = new Map<string, string>();
  const flush = (id: string) => {
    const text = blocks.get(id);
    blocks.delete(id);
    onEvent?.({ type: "text-end", id });
    if (text) onText(text.endsWith("\n") ? text : `${text}\n`, streamed);
  };
  for await (const part of parts) {
    if (part.type === "text-delta" && "text" in part) {
      onEvent?.({
        type: "text",
        ...(part.id === undefined ? {} : { id: part.id }),
        delta: part.text,
      });
      if (part.id === undefined) onText(part.text, streamed);
      else blocks.set(part.id, (blocks.get(part.id) ?? "") + part.text);
    } else if (part.type === "text-end" && "id" in part) flush(part.id);
    else if (part.type === "tool-call" && "toolName" in part) {
      onEvent?.({ type: "tool", name: part.toolName, summary: toolSummary(part.input) });
    } else if ((part.type === "tool-result" || part.type === "tool-error") && "toolName" in part) {
      onEvent?.({ type: "tool-done", name: part.toolName, failed: part.type === "tool-error" });
    } else if (part.type === "error" && "error" in part) failure = describe(part.error);
    else if (part.type === "finish" && "finishReason" in part && part.finishReason === "error")
      failure ??= "the agent ended with an error";
  }
  for (const id of blocks.keys()) flush(id);
  return failure;
}

export function createHarnessStageAgent(options: HarnessStageAgentOptions): StageAgent {
  return {
    async turn({ worksetId, prompt, signal, onText, onEvent, env: turnEnv }): Promise<TurnOutcome> {
      const [{ HarnessAgent }, { createClaudeCode }, { tool }, { z }] = await Promise.all([
        import("@ai-sdk/harness/agent"),
        import("@ai-sdk/harness-claude-code"),
        import("ai"),
        import("zod"),
      ]);
      let asked: AgentQuestion[] | null = null;
      const turnAbort = new AbortController();
      const forward = () => turnAbort.abort(signal.reason);
      signal.addEventListener("abort", forward, { once: true });

      const askHuman = tool({
        description:
          "Ask the engineer what you cannot answer from the Workset, the code or the companion. Put every question you can already ask into one call; ask a follow-up only once it depends on an answer. When an answer is a choice, give 2-4 short options and the one you recommend. The turn ends; the answers arrive as the next message.",
        inputSchema: z.object({
          questions: z
            .array(
              z.object({
                question: z.string().min(1),
                options: z.array(z.string().min(1)).max(5).optional(),
                recommended: z.string().min(1).optional(),
              }),
            )
            .min(1)
            .max(5),
        }),
        execute: async (input) => {
          asked = input.questions.map((entry) => ({
            question: entry.question,
            ...(entry.options?.length ? { options: entry.options } : {}),
            ...(entry.recommended ? { recommended: entry.recommended } : {}),
          }));
          // The tool result reaches the agent first, then the turn is cut.
          setTimeout(() => turnAbort.abort(new Error("waiting for a person")), 0);
          return ASK_HUMAN_REPLY;
        },
      });
      let situation: Omit<Situation, "at" | "stage"> | null = null;
      const reportSituation = tool({
        description:
          "Tell the person, in one plain sentence, what now exists or was decided for this Outcome; never name a skill or agent. After verification, pass the checks you ran and whether each passed.",
        inputSchema: z.object({
          situation: z.string().min(1),
          checks: z
            .array(z.object({ name: z.string().min(1), passed: z.boolean() }))
            .max(10)
            .optional(),
        }),
        execute: async (reported) => {
          situation = {
            text: reported.situation.trim(),
            ...(reported.checks?.length ? { checks: reported.checks } : {}),
          };
          return "Situation recorded.";
        },
      });
      const worktree = options.worktreeOf(worksetId);
      const record = await findWorkset(options.companionPath, worksetId);
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
        harness: createClaudeCode({ auth: {}, port: BRIDGE_PORT, env: { ...env, ...turnEnv } }),
        tools: { ask_human: askHuman, report_situation: reportSituation },
        // Nobody answers Claude's own question tool in an unattended turn; ask_human is the way to ask.
        inactiveTools: ["askUserQuestions"],
        skills,
        instructions: `${instructions}\n\n${factoryRunInstructions()}`,
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
      const resumeFrom = await options.runs.resume(worksetId);
      const session = await agent.createSession({
        sandboxSession: sandbox,
        ...(resumeFrom ? { resumeFrom: resumeFrom as never } : {}),
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
          onEvent,
        );
        if (failure !== null) throw new StageError(`the agent turn failed: ${failure}`);
      } catch (error) {
        if (asked === null) throw error;
      } finally {
        signal.removeEventListener("abort", forward);
        const resume = await session.stop().catch(() => undefined);
        const reported = situation as Omit<Situation, "at" | "stage"> | null;
        await options.runs.saveTurn(worksetId, resume, reported ?? undefined);
        await sandbox.stop();
      }
      const questions = asked as AgentQuestion[] | null;
      return questions === null ? { kind: "done" } : { kind: "question", questions };
    },
  };
}
