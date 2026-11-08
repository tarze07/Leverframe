import { WelcomePanel } from "../features/editor/WelcomePanel";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { SessionPlayer } from "../features/sessions/SessionPlayer";
import { AgentLogPanel } from "../features/sessions/AgentLogPanel";
import { EditorPanel } from "../features/editor/EditorPanel";
import { EditorTab } from "../features/editor/EditorTab";
import { DockArea } from "../workbench/DockArea";

/** Panel components available in the central area. Editors (#8) register here. */
const components = {
  welcome: WelcomePanel,
  terminal: TerminalPanel,
  session: SessionPlayer,
  agentLog: AgentLogPanel,
  editor: EditorPanel,
};

const tabComponents = { editor: EditorTab };

/** Central editor/terminal area: tabs, splits, drag & drop, persisted layout. */
export function Workbench() {
  return (
    <DockArea
      id="main"
      components={components}
      tabComponents={tabComponents}
      addDefaultPanels={(api) => api.addPanel({ id: "welcome", component: "welcome", title: "Witaj" })}
    />
  );
}
