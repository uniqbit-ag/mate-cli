import * as vscode from "vscode";

import type {
  SessionEnvelopeCandidateV1,
  SessionEnvelopeDiagnosticV1,
  SessionEnvelopeResolutionV1,
} from "./schema";
import type { ResolveSessionEnvelopeRequest, WorkspaceService } from "./workspace-service";

export const MATE_CHAT_PARTICIPANT_ID = "mate.chat";

export interface NativeChatConversationState {
  pinnedRepositoryLink?: SessionEnvelopeCandidateV1;
}

export interface NativeChatResolutionDeps {
  resolve: (request: ResolveSessionEnvelopeRequest) => Promise<SessionEnvelopeResolutionV1>;
  pick: (
    candidates: readonly SessionEnvelopeCandidateV1[],
  ) => Promise<SessionEnvelopeCandidateV1 | undefined>;
}

export interface NativeChatResolutionResult {
  state: NativeChatConversationState;
  resolution: SessionEnvelopeResolutionV1;
}

function explicitRequest(
  request: ResolveSessionEnvelopeRequest,
  link: SessionEnvelopeCandidateV1,
): ResolveSessionEnvelopeRequest {
  return {
    ...request,
    companionPath: link.companionPath,
    repositoryId: link.repository.id,
    repositoryPath: link.repository.path,
  };
}

function firstDiagnostic(
  resolution: SessionEnvelopeResolutionV1,
): SessionEnvelopeDiagnosticV1 | undefined {
  return resolution.diagnostics[0];
}

async function resolvePinnedLink(
  state: NativeChatConversationState,
  request: ResolveSessionEnvelopeRequest,
  deps: NativeChatResolutionDeps,
): Promise<NativeChatResolutionResult> {
  const pinned = state.pinnedRepositoryLink!;
  const resolution = await deps.resolve(explicitRequest(request, pinned));
  const diagnostic = firstDiagnostic(resolution);
  if (!diagnostic || diagnostic.candidates.length === 0) return { state, resolution };

  const picked = await deps.pick(diagnostic.candidates);
  if (!picked) return { state, resolution };
  const pickedResolution = await deps.resolve(explicitRequest(request, picked));
  return pickedResolution.status === "resolved"
    ? { state: { pinnedRepositoryLink: picked }, resolution: pickedResolution }
    : { state, resolution: pickedResolution };
}

/** Resolves and pins one Repository Link, never replacing a pinned link from active-context changes. */
export async function resolveNativeChatConversation(
  state: NativeChatConversationState,
  request: ResolveSessionEnvelopeRequest,
  deps: NativeChatResolutionDeps,
): Promise<NativeChatResolutionResult> {
  if (state.pinnedRepositoryLink) return resolvePinnedLink(state, request, deps);

  const resolution = await deps.resolve(request);
  if (resolution.status === "resolved" && resolution.envelope) {
    return {
      state: { pinnedRepositoryLink: resolution.envelope.repositoryLink },
      resolution,
    };
  }

  const diagnostic = firstDiagnostic(resolution);
  if (!diagnostic || diagnostic.candidates.length === 0) return { state, resolution };

  const picked = await deps.pick(diagnostic.candidates);
  if (!picked) return { state, resolution };
  const pickedResolution = await deps.resolve(explicitRequest(request, picked));
  return pickedResolution.status === "resolved"
    ? { state: { pinnedRepositoryLink: picked }, resolution: pickedResolution }
    : { state, resolution: pickedResolution };
}

class NativeChatConversationStore {
  private readonly states = new Map<string, NativeChatConversationState>();

  get(key: string): NativeChatConversationState {
    return this.states.get(key) ?? {};
  }

  set(key: string, state: NativeChatConversationState): void {
    this.states.set(key, state);
  }
}

function conversationKey(chatContext: unknown, request: { prompt: string }): string {
  if (typeof chatContext === "object" && chatContext !== null) {
    const context = chatContext as { conversationId?: unknown; id?: unknown; history?: unknown[] };
    if (typeof context.conversationId === "string") return `conversation:${context.conversationId}`;
    if (typeof context.id === "string") return `conversation:${context.id}`;
    const firstPrompt = context.history?.find((turn) => {
      if (typeof turn !== "object" || turn === null) return false;
      return typeof (turn as { request?: { prompt?: unknown } }).request?.prompt === "string";
    }) as { request?: { prompt?: string } } | undefined;
    if (firstPrompt?.request?.prompt) return `prompt:${firstPrompt.request.prompt}`;
  }
  return `prompt:${request.prompt}`;
}

function activeEditorPath(): string | undefined {
  const editor = (
    vscode.window as unknown as {
      activeTextEditor?: { document?: { uri?: { fsPath?: string } } };
    }
  ).activeTextEditor;
  return editor?.document?.uri?.fsPath;
}

async function pickRepositoryLink(
  candidates: readonly SessionEnvelopeCandidateV1[],
): Promise<SessionEnvelopeCandidateV1 | undefined> {
  const items = candidates.map((candidate) => ({
    label: candidate.repository.id,
    description: candidate.companionPath,
    detail: candidate.repository.path,
    candidate,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a Repository Link for this Mate chat conversation",
  });
  return picked?.candidate;
}

function renderDiagnostic(resolution: SessionEnvelopeResolutionV1): string {
  const diagnostic = firstDiagnostic(resolution);
  return diagnostic
    ? `Mate could not resolve a Session Envelope: ${diagnostic.message}\n\nStart a new conversation or select a valid Repository Link before using Mate context.`
    : "Mate could not resolve a Session Envelope before applying context.";
}

/** Registers the native editor chat projection over the read-only workspace resolver boundary. */
export function registerNativeChatHost(
  context: vscode.ExtensionContext,
  options: {
    workspaceService: WorkspaceService;
    getWorkspaceFolderPaths: () => readonly string[];
  },
): void {
  const conversations = new NativeChatConversationStore();
  const participant = vscode.chat.createChatParticipant(
    MATE_CHAT_PARTICIPANT_ID,
    async (request, chatContext, stream, token) => {
      if (token.isCancellationRequested) return;
      const requestContext: ResolveSessionEnvelopeRequest = {
        host: MATE_CHAT_PARTICIPANT_ID,
        cwd: options.getWorkspaceFolderPaths()[0],
        activePath: activeEditorPath(),
        workspaceRoots: options.getWorkspaceFolderPaths(),
      };
      const key = conversationKey(chatContext, request);
      const current = conversations.get(key);
      const result = await resolveNativeChatConversation(current, requestContext, {
        resolve: (value) => options.workspaceService.resolveSessionEnvelope(value),
        pick: pickRepositoryLink,
      });
      conversations.set(key, result.state);
      if (result.resolution.status !== "resolved" || !result.resolution.envelope) {
        stream.markdown(renderDiagnostic(result.resolution));
        return;
      }

      const envelope = result.resolution.envelope;
      stream.markdown(
        [
          `Mate Session Envelope`,
          `\n\nWorking repository: \`${envelope.workingRepositoryPath}\``,
          `\nCompanion repository: \`${envelope.companionRepositoryPath}\``,
          `\n\n${envelope.renderedGuidance}`,
        ].join(""),
      );
    },
  );
  participant.iconPath = new vscode.ThemeIcon("hubot");
  context.subscriptions.push(participant);
}
