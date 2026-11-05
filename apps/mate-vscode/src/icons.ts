/**
 * Sidebar icons: a codicon plus a theme color, so one meaning has one shape and
 * color in every view. Colors are theme tokens, so they follow the user's theme.
 */
export interface Icon {
  id: string;
  color?: string;
}

export const ICONS = {
  /** Workset groups: a library of changes, not a branch or a folder on disk. */
  workset: { id: "folder-library", color: "charts.purple" },
  branch: { id: "git-branch", color: "charts.blue" },
  defaultBranch: { id: "source-control" },
  older: { id: "history", color: "disabledForeground" },

  sessionHere: { id: "terminal", color: "charts.green" },
  sessionElsewhere: { id: "remote", color: "charts.blue" },
  sessionWaiting: { id: "bell-dot", color: "charts.orange" },
  sessionParked: { id: "debug-pause", color: "descriptionForeground" },

  worktree: { id: "folder" },
  /** A Workset's worktree: the Workset's color, a branch's shape. */
  worksetWorktree: { id: "git-branch", color: "charts.purple" },

  changeDone: { id: "pass-filled", color: "charts.green" },
  changeInProgress: { id: "circle-outline", color: "charts.yellow" },
  changeOpen: { id: "circle-outline" },

  readyToPublish: { id: "cloud-upload", color: "charts.green" },
  waitingForMerge: { id: "git-pull-request", color: "charts.yellow" },

  error: { id: "error", color: "errorForeground" },
} as const satisfies Record<string, Icon>;
