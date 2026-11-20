import { createServerFn } from "@tanstack/react-start";
import {
  COMPANION_DIGEST_PATTERN,
  WORK_REQUEST_ACTIONS,
  type StudioWorkPayload,
  type WorkRequest,
  type WorkResult,
} from "@uniqbit/mate-core/studio";

/** Bounds on what a Work request may carry; core validates meaning, this only shape and size. */
const MAX_TEXT = 64 * 1024;
const MAX_NAME = 128;
const MAX_LIST = 64;
const NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface WorkActionInput {
  companion: string;
  request: WorkRequest;
}

function fail(reason: string): never {
  throw new Error(reason);
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.length > max) fail(`${field} is missing or too long`);
  return value;
}

function optionalText(value: unknown, field: string, max = MAX_NAME): string | undefined {
  return value === undefined || value === "" ? undefined : text(value, field, max);
}

function name(value: unknown, field: string): string {
  const candidate = text(value, field, MAX_NAME);
  if (!NAME.test(candidate)) fail(`${field} is not a valid name`);
  return candidate;
}

function names(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST) fail(`${field} must be a short list`);
  return value.map((entry) => name(entry, field));
}

function key(value: unknown): string {
  const candidate = text(value, "key", MAX_NAME);
  if (!KEY.test(candidate)) fail("key is not valid");
  return candidate;
}

function mode(value: unknown): "propose-only" | "delivery" {
  if (value !== "propose-only" && value !== "delivery")
    fail("mode must be propose-only or delivery");
  return value;
}

/** Shape and bounds only; core's services recheck everything they act on. */
export function validateWorkAction(input: WorkActionInput): WorkActionInput {
  if (typeof input?.companion !== "string" || !COMPANION_DIGEST_PATTERN.test(input.companion)) {
    fail("no registered companion was selected");
  }
  const raw = (input.request ?? {}) as Record<string, unknown>;
  const action = raw.action;
  if (!(WORK_REQUEST_ACTIONS as readonly unknown[]).includes(action)) {
    fail(`unknown Work action ${JSON.stringify(action)}`);
  }
  const request = ((): WorkRequest => {
    switch (action as WorkRequest["action"]) {
      case "capture": {
        const repository = optionalText(raw.repository, "repository");
        const ticket = optionalText(raw.ticket, "ticket");
        const capture: WorkRequest = { action: "capture", text: text(raw.text, "text") };
        return {
          ...capture,
          ...(repository ? { repository } : {}),
          ...(ticket ? { ticket } : {}),
          ...(raw.start !== undefined ? { start: mode(raw.start) } : {}),
        };
      }
      case "refresh":
        return { action: "refresh" };
      case "share-preview":
        return {
          action: "share-preview",
          workset: name(raw.workset, "workset"),
          include: names(raw.include, "include"),
        };
      case "share":
        return {
          action: "share",
          workset: name(raw.workset, "workset"),
          hash: text(raw.hash, "hash", 128),
          include: names(raw.include, "include"),
          key: key(raw.key),
        };
      case "claim":
      case "release":
        return {
          action: action as "claim" | "release",
          workset: name(raw.workset, "workset"),
          members: names(raw.members, "members"),
          key: key(raw.key),
        };
      case "start-manual":
        return {
          action: "start-manual",
          workset: name(raw.workset, "workset"),
          members: names(raw.members, "members"),
        };
      case "dispatch":
        return {
          action: "dispatch",
          workset: name(raw.workset, "workset"),
          mode: mode(raw.mode),
          members: names(raw.members, "members"),
        };
      case "park":
      case "move-to-later":
        return {
          action: action as "park" | "move-to-later",
          workset: name(raw.workset, "workset"),
        };
    }
  })();
  return { companion: input.companion, request };
}

/** One Work action; a refusal comes back as a typed result for the dialog to show. */
export const runWorkAction = createServerFn({ method: "POST" })
  .validator(validateWorkAction)
  .handler(async ({ data, context }): Promise<WorkResult> => {
    try {
      return await context.studio.workAction(data.companion, data.request);
    } catch (error) {
      // An unexpected failure is still shown as a refusal, never as a silent success.
      return { ok: false, kind: "failed", reason: (error as Error).message.slice(0, 600) };
    }
  });

/** The Work view's model for one companion. */
export const getWork = createServerFn({ method: "GET" })
  .validator((input: { companion: string }) => {
    if (!COMPANION_DIGEST_PATTERN.test(input?.companion ?? "")) {
      throw new Error("no registered companion was selected");
    }
    return { companion: input.companion };
  })
  .handler(async ({ data, context }): Promise<StudioWorkPayload> =>
    context.studio.work(data.companion),
  );
