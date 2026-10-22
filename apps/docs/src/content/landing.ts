/** Landing page copy. Describe only what ships in the current release. */

export interface Step {
  title: string;
  command: string;
  description: string;
}

export interface UseCase {
  title: string;
  description: string;
  /** Page slug under `/docs/scenarios/`. */
  slug: string;
}

export interface Capability {
  name: string;
  description: string;
}

export interface TerminalLine {
  kind: "command" | "output";
  text: string;
}

export const installCommand = "npm install -g @uniqbit/mate";

export const hero = {
  badge: "Alpha",
  tagline: "Coding agents that already know your project.",
  description:
    "Mate keeps your agent instructions, skills, and tools in a companion repository and wires them into Claude Code or OpenCode every time you launch.",
  primaryCta: { label: "Read the quickstart", href: "/docs/getting-started/quickstart" },
  secondaryCta: { label: "Browse the docs", href: "/docs" },
};

export const terminal: TerminalLine[] = [
  { kind: "command", text: "mate install" },
  { kind: "output", text: "✓ Core requirements installed" },
  { kind: "command", text: "mate companion link" },
  { kind: "output", text: "✓ Linked companion acme-companion" },
  { kind: "output", text: "✓ Installed selected capabilities" },
  { kind: "command", text: "mate claude" },
  { kind: "output", text: "→ Resolve · Sync · Index · Launch" },
  { kind: "output", text: "✓ Claude Code started with companion context" },
];

export const problemIdea = {
  problem: {
    title: "Your team's AI work is invisible to the business",
    points: [
      "Product owners, business analysts, and developers all use AI to shape requirements, plans, and decisions.",
      "The results stay in private chats, local files, or scattered across code repositories the business side never opens.",
      "Teams spend extra effort aligning, and it gets harder to trace why something was built.",
    ],
  },
  idea: {
    title: "One shared source of truth for every role",
    points: [
      "A companion repository collects specifications, plans, and decisions in one place that every role can read and contribute to.",
      "Documentation comes for free: developers following the recommended Mate workflow produce up-to-date specs as a by-product of delivery.",
      "The business sees what is being built and why, and every AI session starts from the same, current context.",
    ],
    guardrails:
      "Secret guardrails are on by default: agents are kept away from secret files, and secrets are kept out of indexes and companion artifacts.",
  },
};

export const steps: Step[] = [
  {
    title: "Install",
    command: "mate install",
    description:
      "Install the CLI from npm, then verify Mate's core runtime in your working repository.",
  },
  {
    title: "Link",
    command: "mate companion link",
    description:
      "Pick a registered companion or clone one from Git. Mate installs what the companion selects.",
  },
  {
    title: "Launch",
    command: "mate claude",
    description: "Start Claude Code or OpenCode with the companion's context already wired in.",
  },
];

export const repoModel = {
  title: "Two repositories, two jobs",
  description:
    "The companion repository holds everything your agents need. Working repositories hold your product. One companion can serve many working repositories, and each keeps its own history.",
  href: "/docs/concepts/repositories",
};

export const useCases: UseCase[] = [
  {
    title: "Your first agent session",
    description:
      "Go from a fresh install to a running agent that knows your project in three commands.",
    slug: "first-agent-session",
  },
  {
    title: "One companion, many repositories",
    description:
      "Share one set of instructions, skills, and capabilities across several codebases.",
    slug: "one-companion-many-repos",
  },
  {
    title: "Design a team companion",
    description: "Set the agents, rules, skills, and guardrails your whole team works with.",
    slug: "design-a-team-companion",
  },
];

/** Names must match the docs Capabilities page. */
export const capabilities: Capability[] = [
  { name: "OpenSpec", description: "Spec-driven change workflows" },
  { name: "Graphify", description: "Repository knowledge graphs" },
  { name: "TokenSave", description: "Code-graph exploration through MCP" },
  { name: "React Doctor", description: "React diagnostics" },
];

export const capabilitiesHref = "/docs/capabilities";

export const closing = {
  title: "Give your agents the context they need.",
  description: "Install Mate, link a companion, and launch your first session in a few minutes.",
  cta: { label: "Get started", href: "/docs/getting-started/quickstart" },
  alphaNote: "Mate is alpha software. Commands and behavior can change between releases.",
};
