import { WelcomePanel } from "../features/editor/WelcomePanel";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { DockArea } from "../workbench/DockArea";

/** Panel components available in the central area. Editors (#8) register here. */
const components = {
  welcome: WelcomePanel,
  terminal: TerminalPanel,
};

/** Central editor/terminal area: tabs, splits, drag & drop, persisted layout. */
export function Workbench() {
  return (
    <DockArea
      id="main"
      components={components}
      addDefaultPanels={(api) => api.addPanel({ id: "welcome", component: "welcome", title: "Witaj" })}
    />
  );
}
