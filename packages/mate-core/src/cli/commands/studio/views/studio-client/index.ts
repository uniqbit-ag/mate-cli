import { wireCopyControls, wireDelegatedActions } from "./actions";
import { rememberCompanion } from "./companion";
import { wireNavigation } from "./page";
import { wireReports } from "./reports";
import { wireSkillsSelect, wireWorkflowSchemaSelect, wireWorkflowStageSelection } from "./panels";
import { wireTheme, wireThemeToggle } from "./theme";
import { wireUnloadGuard } from "./vault-editor";
import { wireVaultPane } from "./vault-pane";
import { wireVaultBrowser } from "./vault-tree";

/**
 * The only browser code Studio ships beyond the prepaint script: cycling the
 * appearance, remembering the companion on screen, switching the workflow
 * schema, marking the selected workflow stage, copying a prompt, the vault's editor, filter and tree toggle, swapping
 * in a deferred vault tree, and hosted reports. Each needs an API the server
 * does not have; all markup comes from the server.
 */
export function startStudioClient(): void {
  wireTheme();
  rememberCompanion();
  wireWorkflowSchemaSelect();
  wireWorkflowStageSelection();
  wireSkillsSelect();
  wireThemeToggle();
  wireCopyControls();
  wireDelegatedActions();
  wireUnloadGuard();
  wireNavigation();
  wireVaultPane();
  wireVaultBrowser();
  wireReports();
}
