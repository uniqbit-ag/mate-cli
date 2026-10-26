import { wireCopyControls, wireDelegatedActions } from "./actions";
import { rememberCompanion } from "./companion";
import { wireNavigation } from "./page";
import { wireReports } from "./reports";
import { wireSkillTabs, wireWorkflowSchemaTabs } from "./tabs";
import { wireTheme, wireThemeToggle } from "./theme";
import { wireUnloadGuard } from "./vault-editor";
import { wireVaultPane } from "./vault-pane";
import { wireVaultBrowser } from "./vault-tree";

/**
 * The only browser code Studio ships beyond the prepaint script: cycling the
 * appearance, remembering the companion on screen, switching workflow schema
 * tabs, copying a prompt, the vault's editor, filter and tree toggle, swapping
 * in a deferred vault tree, and hosted reports. Each needs an API the server
 * does not have; all markup comes from the server.
 */
export function startStudioClient(): void {
  wireTheme();
  rememberCompanion();
  wireWorkflowSchemaTabs();
  wireSkillTabs();
  wireThemeToggle();
  wireCopyControls();
  wireDelegatedActions();
  wireUnloadGuard();
  wireNavigation();
  wireVaultPane();
  wireVaultBrowser();
  wireReports();
}
