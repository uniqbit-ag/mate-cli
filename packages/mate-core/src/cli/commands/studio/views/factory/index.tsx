/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload, StudioWorkset } from "../../payload";
import type { FactoryRunView } from "../../factory-runs";
import {
  FACTORY_WORKSETS_ROUTE,
  factoryActionRoute,
  factoryAdvanceRoute,
  factoryLogRoute,
} from "../../routes";
import { COMPANION_PARAM } from "../../selection";
import { Warnings } from "../warnings";
import { type FactoryColumnId, factoryColumnOf, PHASE_LABELS } from "../workflow/steps";

interface FactoryProps {
  payload: StudioCompanionPayload;
  companionDigest: string;
  writable: boolean;
  /** Live Workset sessions by Workset id; `null` outside factory mode or without the terminal. */
  sessions?: Record<string, string> | null;
  /** AFK runs by Workset id; `null` without the runner, which hides its controls. */
  runs?: Record<string, FactoryRunView> | null;
}

const ACTIVE_RUN = new Set(["queued", "running"]);

/** A question the agent is waiting on makes the card the person's turn. */
function turnOf(workset: StudioWorkset, run: FactoryRunView | undefined): StudioWorkset["turn"] {
  return run?.state === "waiting" ? "human" : workset.turn;
}

function ActionForm({
  id,
  action,
  label,
  companionDigest,
  children,
}: {
  id: string;
  action: string;
  label: string;
  companionDigest: string;
  children?: unknown;
}) {
  return (
    <form method="post" action={factoryActionRoute(id, action)} className="factory-action">
      <input type="hidden" name={COMPANION_PARAM} value={companionDigest} />
      {children}
      <button type="submit">{label}</button>
    </form>
  );
}

function RunStatus({ workset, run }: { workset: StudioWorkset; run: FactoryRunView }) {
  const log = (
    <a href={factoryLogRoute(workset.id)} target="_blank" rel="noreferrer">
      log
    </a>
  );
  if (ACTIVE_RUN.has(run.state)) {
    return (
      <span className="factory-run-state">
        {run.state === "queued" ? "Queued" : "Running"} {"stage" in run ? run.stage : ""} · {log}
      </span>
    );
  }
  if (run.state === "waiting") return <p className="factory-question">{run.question}</p>;
  if (run.state === "failed") {
    return (
      <p className="factory-problems">
        {run.reason} {log}
      </p>
    );
  }
  if (run.state === "interrupted") {
    return <p className="factory-problems">Interrupted when Studio stopped. {log}</p>;
  }
  return null;
}

function PushedBranch({ run }: { run: FactoryRunView }) {
  if (!run.pushedBranch) return null;
  return (
    <span className="factory-card-meta mono">
      {run.compareUrl ? (
        <a href={run.compareUrl} target="_blank" rel="noreferrer">
          {run.pushedBranch}
        </a>
      ) : (
        run.pushedBranch
      )}
    </span>
  );
}

/** The one action a card offers for its run, if any; people start apply and publish. */
function runAction(workset: StudioWorkset, run: FactoryRunView | undefined): string | null {
  if (run?.state === "waiting") return "answer";
  if (run && ACTIVE_RUN.has(run.state)) return "cancel";
  if (run?.state === "failed" || run?.state === "interrupted") return "retry";
  if (workset.stage === "human-review") return "start-apply";
  if (workset.stage === "publish") return "publish";
  return null;
}

const ACTION_LABELS: Record<string, string> = {
  answer: "Answer",
  cancel: "Cancel",
  retry: "Retry",
  "start-apply": "Start apply",
  publish: "Publish",
};

function RunPanel({
  workset,
  run,
  companionDigest,
  writable,
}: {
  workset: StudioWorkset;
  run: FactoryRunView | undefined;
  companionDigest: string;
  writable: boolean;
}) {
  const action = writable ? runAction(workset, run) : null;
  return (
    <div className="factory-run" data-run={run?.state ?? "idle"}>
      {run ? <RunStatus workset={workset} run={run} /> : null}
      {run ? <PushedBranch run={run} /> : null}
      {action ? (
        <ActionForm
          id={workset.id}
          action={action}
          label={ACTION_LABELS[action]!}
          companionDigest={companionDigest}
        >
          {action === "answer" ? (
            <textarea name="answer" rows={2} required aria-label="Answer" />
          ) : null}
        </ActionForm>
      ) : null}
    </div>
  );
}

/** The human planning stages, which happen in a Workset session. */
const SESSION_STAGES = new Set(["clarify-intent", "explore"]);

function SessionControl({ workset, sessionId }: { workset: StudioWorkset; sessionId?: string }) {
  if (!SESSION_STAGES.has(workset.stage)) return null;
  return sessionId ? (
    <button type="button" data-terminal-attach-session={sessionId}>
      Attach
    </button>
  ) : (
    <button type="button" data-terminal-workset={workset.id}>
      Open session
    </button>
  );
}

const COLUMNS: { id: FactoryColumnId; label: string }[] = [
  { id: "plan", label: PHASE_LABELS.plan },
  { id: "review", label: PHASE_LABELS.review },
  { id: "build", label: PHASE_LABELS.build },
  { id: "ship", label: PHASE_LABELS.ship },
  { id: "done", label: "Done" },
];

const TURN_TEXT: Record<StudioWorkset["turn"], string> = {
  human: "Your turn",
  agent: "Agent's turn",
  none: "Shipped",
};

/** A Workset without changes moves on by hand; every later stage is derived. */
function advanceLabel(workset: StudioWorkset): string | null {
  if (workset.changes.length > 0) return null;
  if (workset.stage === "clarify-intent") return "Intent clarified";
  if (workset.stage === "explore") return "Ready for propose";
  return null;
}

function Card({
  workset,
  companionDigest,
  writable,
  sessions,
  runs,
}: {
  workset: StudioWorkset;
  companionDigest: string;
  writable: boolean;
  sessions: Record<string, string> | null;
  runs: Record<string, FactoryRunView> | null;
}) {
  const advance = writable ? advanceLabel(workset) : null;
  const run = runs?.[workset.id];
  const turn = turnOf(workset, run);
  return (
    <article
      className="factory-card"
      data-workset={workset.id}
      data-turn={turn}
      aria-label={workset.title}
    >
      <header className="factory-card-head">
        <strong className="factory-card-title">{workset.title}</strong>
        <span className="factory-turn" data-turn={turn}>
          {TURN_TEXT[turn]}
        </span>
      </header>
      <span className="factory-card-stage">{workset.stageLabel}</span>
      <span className="factory-card-meta mono">
        {workset.id} · {workset.repositories.join(", ")}
      </span>
      {workset.changes.length > 0 ? (
        <span className="factory-card-meta mono">{workset.changes.join(", ")}</span>
      ) : null}
      {workset.problems.length > 0 ? (
        <ul className="factory-problems">
          {workset.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {sessions ? <SessionControl workset={workset} sessionId={sessions[workset.id]} /> : null}
      {runs ? (
        <RunPanel
          workset={workset}
          run={run}
          companionDigest={companionDigest}
          writable={writable}
        />
      ) : null}
      {advance ? (
        <form method="post" action={factoryAdvanceRoute(workset.id)}>
          <input type="hidden" name={COMPANION_PARAM} value={companionDigest} />
          <button type="submit">{advance}</button>
        </form>
      ) : null}
    </article>
  );
}

function CreateForm({
  repositories,
  companionDigest,
}: {
  repositories: string[];
  companionDigest: string;
}) {
  if (repositories.length === 0) {
    return (
      <p className="note">
        Link a Working Repository to this companion to create a Workset for it.
      </p>
    );
  }
  return (
    <details className="factory-create">
      <summary>New Workset</summary>
      <form method="post" action={FACTORY_WORKSETS_ROUTE} className="factory-create-form">
        <input type="hidden" name={COMPANION_PARAM} value={companionDigest} />
        <label>
          <span>Identifier</span>
          <input name="id" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="acme-login" />
        </label>
        <label>
          <span>Title</span>
          <input name="title" required placeholder="Login with SSO" />
        </label>
        <label>
          <span>Working Repository</span>
          <select name="repository" required>
            {repositories.map((repository) => (
              <option key={repository} value={repository}>
                {repository}
              </option>
            ))}
          </select>
        </label>
        <label className="factory-create-intent">
          <span>Intent</span>
          <textarea name="intent" rows={3} placeholder="Who needs what, and why now" />
        </label>
        <button type="submit">Create</button>
      </form>
    </details>
  );
}

/** One card per Workset in the column of its derived stage; people act only where it is their turn. */
export function Factory({
  payload,
  companionDigest,
  writable,
  sessions = null,
  runs = null,
}: FactoryProps) {
  const yourTurn = payload.worksets.filter(
    (workset) => turnOf(workset, runs?.[workset.id]) === "human",
  ).length;
  return (
    <section className="view-section" aria-label="Factory">
      <div className="view-intro">
        <p className="view-summary">
          {payload.worksets.length} {payload.worksets.length === 1 ? "Workset" : "Worksets"} ·{" "}
          <strong data-your-turn={yourTurn}>{yourTurn} your turn</strong>
        </p>
        {writable ? (
          <CreateForm repositories={payload.linkedRepositories} companionDigest={companionDigest} />
        ) : (
          <p className="note">Read-only mode. Start Studio with --writable to create Worksets.</p>
        )}
      </div>
      {payload.worksets.length === 0 ? (
        <p className="empty">No Worksets in this companion yet.</p>
      ) : null}
      <div className="factory-board">
        {COLUMNS.map((column) => {
          const cards = payload.worksets.filter(
            (workset) => factoryColumnOf(workset.stage) === column.id,
          );
          return (
            <section
              key={column.id}
              className="factory-column"
              data-column={column.id}
              aria-label={column.label}
            >
              <h3>
                {column.label} <span className="muted">{cards.length}</span>
              </h3>
              {cards.map((workset) => (
                <Card
                  key={workset.id}
                  workset={workset}
                  companionDigest={companionDigest}
                  writable={writable}
                  sessions={sessions}
                  runs={runs}
                />
              ))}
            </section>
          );
        })}
      </div>
      {payload.worksetProblems.length > 0 ? (
        <Warnings
          warnings={payload.worksetProblems.map((problem) => `${problem.path} ${problem.reason}`)}
        />
      ) : null}
      <Warnings warnings={payload.warnings} />
    </section>
  );
}
