/**
 * Agent end-to-end scenarios for the Delivery Path: each runs one real headless agent session in
 * a sanitized temporary companion and Working Repository, then checks what the session left.
 */

export const CHANGE = "acme-greeting";

export interface Scenario {
  id: string;
  /** What the scenario proves, in a few words. */
  title: string;
  /** Part of the default run; the others run with `--all`. */
  core?: true;
  /** `.mate/config/workflow.yaml`; the default path without one. */
  workflow?: string;
  /** The companion's own skills the workflow names; as written, with no Mate line. */
  skills?: string[];
  /**
   * Own skills whose author ends them with the closing step anyway, by stage id: Mate asks for
   * none, and records such a report like any other.
   */
  closes?: Record<string, string>;
  /** Steps the change's Delivery Record already holds, by stage id. */
  recorded?: Record<string, string[]>;
  /** The change's `tasks.md` body. */
  tasks?: string;
  /**
   * The change's folder in the companion, for a declared type with its files; the built-in
   * type's `openspec/changes/<change>/` with a spec and `tasks.md` by default.
   */
  folder?: { path: string; files: Record<string, string> };
  /** Files the Working Repository starts with. */
  files?: Record<string, string>;
  /** Bare remotes for the companion and the app, with the files committed and pushed on the delivery branch. */
  delivery?: true;
  prompt: string;
  expect: {
    /** `stages` of the change's Delivery Record, exactly. */
    stages: Record<string, string[]>;
    /** The stage `mate workflow next` puts the change at afterwards. */
    at?: string;
    /** The companion's own skills that ran, in this order. */
    ran?: string[];
    /** Unchecked tasks left in `tasks.md`; unchecked for a change without one. */
    openTasks?: number;
    /** Text the response's `Next steps` section holds. */
    handoff: string[];
    /** Text the section does not hold. */
    notHandoff?: string[];
    /** The companion remote's inbox holds the change, submitted. */
    submitted?: true;
  };
}

const TASKS = `## 1. Greeting

- [ ] 1.1 Create \`greeting.txt\` in the repository root holding the single line \`hello acme\`
- [ ] 1.2 Append the line \`goodbye acme\` to \`greeting.txt\`
`;

const TAIL = `  - id: submit
    artifact: openspec
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`;

const workflow = (stages: string): string => `version: 1\nstages:\n${stages}${TAIL}`;

const APPLY_ALONE = "  - id: apply\n    steps: [{ skill: mate-apply-change }]\n";
const SECURITY_REVIEW = "  - id: security-review\n    steps: [{ skill: acme-security-review }]\n";

const SUBMIT = `/mate-submit-change ${CHANGE}`;
const PUBLISH = "/mate-publish-artifact";
const APPLY = `/mate-apply-change ${CHANGE}`;
const VERIFY = `/acme-verify ${CHANGE}`;

/** A Delivery Path whose stages before submit are all the companion's own skills. */
const FULL_CUSTOM = workflow(
  "  - id: explore\n    steps: [{ skill: acme-explore }]\n" +
    "  - id: propose\n    steps: [{ skill: acme-propose }]\n" +
    "  - id: apply\n    steps: [{ skill: acme-build }, { skill: acme-verify }]\n",
);
const FULL_CUSTOM_SKILLS = ["acme-explore", "acme-propose", "acme-build", "acme-verify"];

export const SCENARIOS: Scenario[] = [
  {
    id: "default-apply",
    title: "default path: apply closes through the CLI and hands off to submit",
    core: true,
    prompt: APPLY,
    expect: {
      stages: { apply: ["mate-apply-change"] },
      openTasks: 0,
      handoff: [SUBMIT],
    },
  },
  {
    id: "default-one-task",
    title: "default path: a one-task change",
    tasks:
      "## 1. Greeting\n\n- [ ] 1.1 Create `greeting.txt` holding the two lines `hello acme` then `goodbye acme`\n",
    prompt: APPLY,
    expect: { stages: { apply: ["mate-apply-change"] }, openTasks: 0, handoff: [SUBMIT] },
  },
  {
    id: "default-already-done",
    title: "default path: every task already checked still closes the stage",
    tasks: TASKS.replaceAll("- [ ]", "- [x]"),
    files: { "greeting.txt": "hello acme\ngoodbye acme\n" },
    prompt: APPLY,
    expect: { stages: { apply: ["mate-apply-change"] }, openTasks: 0, handoff: [SUBMIT] },
  },
  {
    id: "default-open-task",
    title: "default path: an open task hands back to apply, not to submit",
    tasks: `${TASKS}- [ ] 1.3 Needs a decision only the user can make: which third line to add. Do not guess and do not check this task; leave it open and report it.\n`,
    prompt: APPLY,
    expect: {
      stages: { apply: ["mate-apply-change"] },
      openTasks: 1,
      handoff: [APPLY],
      notHandoff: [SUBMIT],
    },
  },
  {
    id: "default-by-request",
    title: "default path: the skill is reached by a plain request",
    prompt: `Implement the change ${CHANGE} with the mate-apply-change skill.`,
    expect: { stages: { apply: ["mate-apply-change"] }, openTasks: 0, handoff: [SUBMIT] },
  },
  {
    id: "chain-verify",
    title: "a stage with a second step hands off to that step and does not run it",
    core: true,
    workflow: workflow(
      "  - id: apply\n    steps: [{ skill: mate-apply-change }, { skill: acme-verify }]\n",
    ),
    skills: ["acme-verify"],
    prompt: APPLY,
    expect: {
      stages: { apply: ["mate-apply-change"] },
      at: "apply",
      openTasks: 0,
      handoff: [VERIFY],
      notHandoff: [SUBMIT],
    },
  },
  {
    id: "second-step",
    title: "the second step, started by the developer, is reported and hands off to submit",
    workflow: workflow(
      "  - id: apply\n    steps: [{ skill: mate-apply-change }, { skill: acme-verify }]\n",
    ),
    skills: ["acme-verify"],
    tasks: TASKS.replaceAll("- [ ]", "- [x]"),
    files: { "greeting.txt": "hello acme\ngoodbye acme\n" },
    recorded: { apply: ["mate-apply-change"] },
    prompt: VERIFY,
    expect: {
      stages: { apply: ["mate-apply-change", "acme-verify"] },
      at: "submit",
      ran: ["acme-verify"],
      openTasks: 0,
      handoff: [SUBMIT],
    },
  },
  {
    id: "missed-report",
    title:
      "a Mate skill that never reported itself blocks nothing: the next step hands off to submit",
    workflow: workflow(
      "  - id: apply\n    steps: [{ skill: mate-apply-change }, { skill: acme-verify }]\n",
    ),
    skills: ["acme-verify"],
    tasks: TASKS.replaceAll("- [ ]", "- [x]"),
    files: { "greeting.txt": "hello acme\ngoodbye acme\n" },
    prompt: VERIFY,
    expect: {
      stages: { apply: ["acme-verify"] },
      at: "submit",
      ran: ["acme-verify"],
      openTasks: 0,
      handoff: [SUBMIT],
    },
  },
  {
    id: "skipped-step",
    title: "a step run out of order counts the one it skipped and hands off to submit",
    workflow: workflow(
      "  - id: apply\n    steps: [{ skill: mate-apply-change }, { skill: acme-lint }, { skill: acme-verify }]\n",
    ),
    skills: ["acme-lint", "acme-verify"],
    tasks: TASKS.replaceAll("- [ ]", "- [x]"),
    files: { "greeting.txt": "hello acme\ngoodbye acme\n" },
    recorded: { apply: ["mate-apply-change"] },
    prompt: VERIFY,
    expect: {
      stages: { apply: ["mate-apply-change", "acme-verify"] },
      at: "submit",
      ran: ["acme-verify"],
      openTasks: 0,
      handoff: [SUBMIT],
      notHandoff: [`1. /acme-lint ${CHANGE}`, `2. /acme-lint ${CHANGE}`],
    },
  },
  {
    id: "three-steps",
    title: "the first of three steps hands off to the second only",
    workflow: workflow(
      "  - id: apply\n    steps: [{ skill: mate-apply-change }, { skill: acme-lint }, { skill: acme-verify }]\n",
    ),
    skills: ["acme-lint", "acme-verify"],
    prompt: APPLY,
    expect: {
      stages: { apply: ["mate-apply-change"] },
      openTasks: 0,
      handoff: [`/acme-lint ${CHANGE}`],
      notHandoff: [VERIFY, SUBMIT],
    },
  },
  {
    id: "custom-entry",
    title: "a stage started with a custom skill hands off to its Mate skill",
    workflow: workflow(
      "  - id: apply\n    steps: [{ skill: acme-prepare }, { skill: mate-apply-change }]\n",
    ),
    skills: ["acme-prepare"],
    prompt: `/acme-prepare ${CHANGE}`,
    expect: {
      stages: { apply: ["acme-prepare"] },
      ran: ["acme-prepare"],
      openTasks: 2,
      handoff: [APPLY],
      notHandoff: [SUBMIT],
    },
  },
  {
    id: "custom-stage",
    title: "a custom stage, its skill unchanged, is recorded through the guidance rule",
    core: true,
    workflow: workflow(SECURITY_REVIEW + APPLY_ALONE),
    skills: ["acme-security-review"],
    prompt: `/acme-security-review ${CHANGE}`,
    expect: {
      stages: { "security-review": ["acme-security-review"] },
      at: "apply",
      ran: ["acme-security-review"],
      openTasks: 2,
      handoff: [APPLY],
      notHandoff: [SUBMIT],
    },
  },
  {
    id: "custom-stage-closing",
    title: "a custom skill that reports itself anyway is recorded like any report",
    workflow: workflow(SECURITY_REVIEW + APPLY_ALONE),
    skills: ["acme-security-review"],
    closes: { "acme-security-review": "security-review" },
    prompt: `/acme-security-review ${CHANGE}`,
    expect: {
      stages: { "security-review": ["acme-security-review"] },
      at: "apply",
      ran: ["acme-security-review"],
      openTasks: 2,
      handoff: [APPLY],
      notHandoff: [SUBMIT],
    },
  },
  {
    id: "counted-step",
    title:
      "an unreported custom stage counts once apply is recorded, and apply hands off to submit",
    workflow: workflow(SECURITY_REVIEW + APPLY_ALONE),
    skills: ["acme-security-review"],
    prompt: APPLY,
    expect: {
      stages: { apply: ["mate-apply-change"] },
      at: "submit",
      openTasks: 0,
      handoff: [SUBMIT],
      notHandoff: [`1. /acme-security-review ${CHANGE}`],
    },
  },
  {
    id: "confirmed-step",
    title: "an earlier step the developer says ran is recorded by apply",
    workflow: workflow(SECURITY_REVIEW + APPLY_ALONE),
    skills: ["acme-security-review"],
    prompt: `${APPLY}\n\nI already ran /acme-security-review ${CHANGE} myself.`,
    expect: {
      stages: { "security-review": ["acme-security-review"], apply: ["mate-apply-change"] },
      at: "submit",
      openTasks: 0,
      handoff: [SUBMIT],
    },
  },
  {
    id: "custom-only",
    title: "a workflow of custom skills only is recorded on the guidance rule alone",
    workflow: `version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
    reviews: { brief: brief.md }
    publish:
      apply: { run: "acme-notes merge {change}" }
stages:
  - id: draft
    steps: [{ skill: acme-draft }]
  - id: review
    review: schema
  - id: build
    steps: [{ skill: acme-build }]
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`,
    skills: ["acme-draft", "acme-build"],
    folder: { path: `notes/${CHANGE}`, files: { "brief.md": "# Brief\n\nA greeting note.\n" } },
    recorded: { draft: ["acme-draft"] },
    prompt: `/acme-build ${CHANGE}`,
    expect: {
      stages: { draft: ["acme-draft"], build: ["acme-build"] },
      at: "submit",
      ran: ["acme-build"],
      handoff: [SUBMIT],
    },
  },
  ...fullCustom(),
  submitted("default", undefined, { apply: ["mate-apply-change"] }),
  submitted(
    "mixed",
    workflow(SECURITY_REVIEW + APPLY_ALONE),
    {
      "security-review": ["acme-security-review"],
      apply: ["mate-apply-change"],
    },
    ["acme-security-review"],
  ),
  submitted(
    "custom",
    FULL_CUSTOM,
    {
      explore: ["acme-explore"],
      propose: ["acme-propose"],
      apply: ["acme-build", "acme-verify"],
    },
    FULL_CUSTOM_SKILLS,
  ),
];

/**
 * Submit of a change whose earlier stages are all recorded, against bare remotes: it pushes the
 * change to the inbox and hands off to the merge and publish.
 */
function submitted(
  kind: string,
  declared: string | undefined,
  recorded: Record<string, string[]>,
  skills: string[] = [],
): Scenario {
  return {
    id: `${kind}-submit`,
    title: `${kind} path: submit pushes the change to the inbox and hands off to publish`,
    ...(declared ? { workflow: declared } : {}),
    skills,
    tasks: TASKS.replaceAll("- [ ]", "- [x]"),
    files: { "greeting.txt": "hello acme\ngoodbye acme\n" },
    recorded,
    delivery: true,
    prompt: SUBMIT,
    expect: {
      stages: recorded,
      at: "publish",
      submitted: true,
      handoff: [`workset/${CHANGE}`, PUBLISH],
      notHandoff: [SUBMIT],
    },
  };
}

/**
 * A Delivery Path whose stages before submit are all the companion's own skills, walked one
 * step per session, and once from a cold start at its last step.
 */
function fullCustom(): Scenario[] {
  const declared = FULL_CUSTOM;
  const skills = FULL_CUSTOM_SKILLS;
  // The apply stage stays open while tasks are; acme-build only leaves a marker, so its tasks
  // start done, as if it had implemented them.
  const built = {
    tasks: TASKS.replaceAll("- [ ]", "- [x]"),
    files: { "greeting.txt": "hello acme\ngoodbye acme\n" },
  };
  const chain: [string, string, string][] = [
    ["explore", "acme-explore", "propose"],
    ["propose", "acme-propose", "apply"],
    ["apply", "acme-build", "apply"],
    ["apply", "acme-verify", "submit"],
  ];
  const walk = chain.map(([stage, skill, at], index): Scenario => {
    const recorded: Record<string, string[]> = {};
    for (const [before, step] of chain.slice(0, index)) {
      recorded[before] = [...(recorded[before] ?? []), step];
    }
    const next = chain[index + 1];
    return {
      id: `full-custom-${skill.replace("acme-", "")}`,
      title: `full custom path: ${skill} hands off to ${next ? next[1] : "submit"}`,
      workflow: declared,
      skills,
      ...(stage === "apply" ? built : {}),
      recorded,
      prompt: `/${skill} ${CHANGE}`,
      expect: {
        stages: { ...recorded, [stage]: [...(recorded[stage] ?? []), skill] },
        at,
        ran: [skill],
        handoff: [next ? `/${next[1]} ${CHANGE}` : SUBMIT],
        notHandoff: next ? [SUBMIT] : [],
      },
    };
  });
  return [
    ...walk,
    {
      id: "full-custom-cold",
      title:
        "full custom path: the last step alone counts the earlier ones and hands off to submit",
      workflow: declared,
      skills,
      ...built,
      prompt: `/acme-verify ${CHANGE}`,
      expect: {
        stages: { apply: ["acme-verify"] },
        at: "submit",
        ran: ["acme-verify"],
        handoff: [SUBMIT],
        notHandoff: [`1. /acme-explore ${CHANGE}`, `1. /acme-build ${CHANGE}`],
      },
    },
  ];
}

export const DEFAULT_TASKS = TASKS;

/** The step a skill ends with to close its stage: the same in Mate's skills and a companion's. */
export function closingStep(skill: string): string {
  return `## Finish

When this skill has finished for a change, also with work still open, run:

    mate workflow done ${skill} "<change-name>"

It prints the next actions for the change. End the response with a final \`## Next steps\`
section: numbered required actions in execution order, with exact commands and known
change names, prerequisites first: required work of this run that is still open, then
the actions the command printed, in its order. Summaries, evidence, warnings, optional
work, and deferred context go above it; nothing follows it. Listing an action never
invokes it. Never offer the user an optional command, in or above the section; optional
work appears above it only as a skill invocation labelled optional, as the command's
\`optional:\` line names it. If the command fails, report its problems and end without a
\`Next steps\` section.
`;
}

/**
 * A companion's own skill, written with no Mate line: it runs `acme-step`, which leaves a marker
 * outside both repositories, so a recorded step that never ran is caught. With `stage`, its author ends it with the closing step anyway.
 */
export function customSkill(name: string, stage?: string): string {
  const ending = stage ? closingStep(name) : "";
  return `---
name: ${name}
description: Acme's ${name} step of the Delivery Path. Use when asked to run ${name} for a change.
---

# ${name}

Run this for the change named in the request.

1. Run \`acme-step ${name} "<change-name>"\`.
2. Report in one sentence that ${name} ran for the change.

${ending}
`;
}
